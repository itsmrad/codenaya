import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { CommandExitError, type CommandResult, Sandbox, TimeoutError } from "e2b";

import {
  BUILD_CHECK_UNFINISHED,
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  STATIC_CHECKS_PASSED,
  buildPathIndex,
} from "@/features/conversations/agent-steps";
import {
  MAX_LIVE_SANDBOXES,
  type ProjectFile,
  WORK_DIR,
  createProjectSandbox,
  writeProjectFiles,
} from "@/features/sandbox-preview/server/project-sandbox";
import { withErrorHints } from "@/features/sandbox-preview/utils/error-recipes";
import {
  missingReferencedFiles,
  undeclaredPackages,
  unresolvedImports,
} from "@/features/sandbox-preview/utils/missing-references";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

interface CheckBuildToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  /** Project owner; finds their running preview sandbox to build in (#465). */
  ownerId?: string;
}

/** Install, type check and build together must finish within this. */
const CHECK_TIMEOUT_MS = 120_000;
/** E2B reaps the sandbox after this even if the kill below is lost. */
const SANDBOX_TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_LINES = 40;
/**
 * A warm preview needs this much time left to be reused, so connecting (which
 * only ever raises the timeout to this) never extends or shortens it.
 */
const WARM_MIN_TIME_LEFT_MS = CHECK_TIMEOUT_MS + 60_000;

const ANSI_ESCAPE = /\u001b\[[\d;]*[A-Za-z]/g;

/**
 * The first lines of compiler output, without colour codes, repeated lines or
 * the sandbox's absolute paths, so errors read as `src/App.tsx(3,1): ...`.
 */
export const trimBuildOutput = (output: string, dir = WORK_DIR) => {
  const lines = [
    ...new Set(
      output
        .replace(ANSI_ESCAPE, "")
        .replaceAll(`${dir}/`, "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean),
    ),
  ];
  const more = lines.length - MAX_ERROR_LINES;
  return [
    ...lines.slice(0, MAX_ERROR_LINES),
    ...(more > 0 ? [`… ${more} more line(s)`] : []),
  ].join("\n");
};

/** E2B throws on a non-zero exit; the result is what the caller reports. */
const run = async (
  sandbox: Sandbox,
  command: string,
  timeoutMs: number,
  cwd: string,
): Promise<CommandResult> => {
  try {
    return await sandbox.commands.run(command, { cwd, timeoutMs });
  } catch (error) {
    if (error instanceof CommandExitError) return error;
    throw error;
  }
};

/**
 * Errors first: Vite writes progress to stdout and the failure to stderr.
 * Known errors anywhere in the output get their cause and fix appended.
 */
const failureOutput = (result: CommandResult, dir: string) => {
  const output = `${result.stderr}\n${result.stdout}`;
  return withErrorHints(trimBuildOutput(output, dir), output);
};

/** A timeout or a sandbox failure, not a problem in the project's code. */
const unfinished = (error: unknown) =>
  `${BUILD_CHECK_UNFINISHED} (${error instanceof Error ? error.message : "Unknown error"}). ` +
  "This is not an error in the project's code. Say in Notes that the build was not verified.";

const notBuilt = (reason: string) =>
  `${STATIC_CHECKS_PASSED}\n${reason}, so the type check and build did not run. ` +
  "Say in Notes that the build was not verified.";

/**
 * Writes the files to `dir`, then runs `npm install`, `tsc --noEmit` and
 * `vite build` there. Returns the tool result for a finished check; throws on
 * sandbox failures and timeouts.
 */
const buildIn = async (sandbox: Sandbox, dir: string, files: ProjectFile[], paths: Set<string>) => {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const timeLeft = () => Math.max(1_000, deadline - Date.now());

  await writeProjectFiles(sandbox, files, dir);

  const install = await run(sandbox, "npm install --prefer-offline --no-audit --no-fund --loglevel=error", timeLeft(), dir);
  if (install.exitCode !== 0) {
    return `Error: npm install failed. Fix package.json, then call checkBuild again:\n${failureOutput(install, dir)}`;
  }

  const tsconfig = ["tsconfig.app.json", "tsconfig.json"].find((path) => paths.has(path));
  const command = [tsconfig && `npx tsc --noEmit -p ${tsconfig}`, "npx vite build"]
    .filter(Boolean)
    .join(" && ");
  const build = await run(sandbox, command, timeLeft(), dir);
  if (build.exitCode !== 0) {
    return `Error: Build failed. Fix these errors, then call checkBuild again:\n${failureOutput(build, dir)}`;
  }

  return `${BUILD_VERIFIED}\nDependencies installed, and the type check and production build passed.`;
};

/** The project whose running preview a check may build in, and its owner. */
type WarmPreview = { projectId: string; ownerId: string };

/** An install the preview (or another check) is running; copying node_modules now could catch it half-written. */
const INSTALLING = /\binstall\b/;

/**
 * The owner's running preview sandbox for this project, connected, when it has
 * time left and no install running. The query filters by the tags the preview
 * route sets; they are checked again here because they decide whose sandbox
 * this runs in.
 */
const connectWarmSandbox = async (apiKey: string, { projectId, ownerId }: WarmPreview) => {
  const running = await Sandbox.list({
    apiKey,
    query: { metadata: { userId: ownerId, projectId }, state: ["running"] },
    limit: MAX_LIVE_SANDBOXES,
  }).nextItems();
  const info = running.find(
    (sandbox) =>
      sandbox.metadata.userId === ownerId &&
      sandbox.metadata.projectId === projectId &&
      sandbox.endAt.getTime() - Date.now() > WARM_MIN_TIME_LEFT_MS,
  );
  if (!info) return null;

  const sandbox = await Sandbox.connect(info.sandboxId, { apiKey, timeoutMs: WARM_MIN_TIME_LEFT_MS });
  const processes = await sandbox.commands.list();
  return processes.some((proc) => INSTALLING.test([proc.cmd, ...proc.args].join(" ")))
    ? null
    : sandbox;
};

/**
 * The check in the project's warm preview sandbox, or null to use a new one.
 * It builds in its own directory with a copy of the preview's node_modules, so
 * the dev server, its HMR and its installed packages are left alone, and the
 * preview's `.env` is not read, as on the cold path. Never kills the sandbox.
 */
const checkInWarmSandbox = async (
  apiKey: string,
  preview: WarmPreview,
  files: ProjectFile[],
  paths: Set<string>,
): Promise<string | null> => {
  const dir = `/home/user/check-build-${randomUUID().slice(0, 8)}`;
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await connectWarmSandbox(apiKey, preview);
    if (!sandbox) return null;
    await sandbox.commands.run(`mkdir -p ${dir} && cp -a ${WORK_DIR}/node_modules ${dir}/`, {
      timeoutMs: 60_000,
    });
  } catch (error) {
    console.error("[check-build] warm sandbox unavailable, starting a new one", error);
    await sandbox?.commands.run(`rm -rf ${dir}`, { background: true }).catch(() => {});
    return null;
  }

  try {
    return await buildIn(sandbox, dir, files, paths);
  } catch (error) {
    // A slow build would time out in a new sandbox too.
    if (error instanceof TimeoutError) return unfinished(error);
    console.error("[check-build] warm sandbox failed, starting a new one", error);
    return null;
  } finally {
    await sandbox.commands.run(`rm -rf ${dir}`, { background: true }).catch(() => {});
  }
};

/**
 * Static checks, then `npm install`, `tsc --noEmit` and `vite build`: in the
 * owner's running preview sandbox when there is one, else in a throwaway
 * sandbox. Returns the tool result: a passing summary, or an "Error: ..."
 * message the agent can act on. Never throws.
 *
 * `paths` holds every project file, including uploads with no text content.
 */
export const checkProjectBuild = async ({
  files,
  paths,
  apiKey,
  metadata,
  preview,
}: {
  files: ProjectFile[];
  paths: Set<string>;
  apiKey?: string;
  metadata?: Record<string, string>;
  preview?: WarmPreview;
}): Promise<string> => {
  const problems = [
    ...missingReferencedFiles(files),
    ...undeclaredPackages(files),
    ...unresolvedImports(files, paths),
  ];
  if (problems.length > 0) {
    return (
      `${STATIC_CHECKS_FAILED}:\n- ${problems.join("\n- ")}\n` +
      "Fix these, then call checkBuild again."
    );
  }

  const isVite =
    paths.has("package.json") && [...paths].some((path) => /^vite\.config\.[cm]?[jt]s$/.test(path));
  if (!isVite) {
    return `${BUILD_NOT_CHECKED}\nStatic checks passed. checkBuild only builds Vite projects, so this one was not built.`;
  }

  if (!apiKey) {
    return notBuilt("No build sandbox is configured");
  }

  if (preview) {
    const warm = await checkInWarmSandbox(apiKey, preview, files, paths);
    if (warm) return warm;
  }

  let sandbox: Sandbox;
  try {
    sandbox = await createProjectSandbox({ apiKey, timeoutMs: SANDBOX_TIMEOUT_MS, metadata });
  } catch (error) {
    console.error("[check-build] sandbox creation failed", error);
    return notBuilt("The build sandbox could not start");
  }

  try {
    return await buildIn(sandbox, WORK_DIR, files, paths);
  } catch (error) {
    return unfinished(error);
  } finally {
    await sandbox.kill().catch(() => {});
  }
};

export const createCheckBuildTool = ({
  projectId,
  internalKey,
  ownerId,
}: CheckBuildToolOptions) => {
  return createTool({
    name: "checkBuild",
    description:
      "Check that the project builds: looks for missing files, undeclared packages and broken imports, then installs dependencies and runs the TypeScript check and the Vite production build in a sandbox. " +
      "Call it once before the final summary when files changed. Returns the errors to fix, or a passing result.",
    parameters: z.object({}),
    handler: async (_params, { step: toolStep }) => {
      try {
        return await toolStep?.run("check-build", async () => {
          // The metadata list has no text since #412; this one carries it.
          const rows = await convex.query(api.system.getProjectFilesWithUrls, {
            internalKey,
            projectId,
          });
          const pathOf = buildPathIndex(rows);
          const files: ProjectFile[] = [];
          const paths = new Set<string>();
          for (const row of rows) {
            const path = row.type === "file" ? pathOf(row._id) : undefined;
            if (!path) continue;
            paths.add(path);
            if (typeof row.content === "string") files.push({ path, content: row.content });
          }

          return await checkProjectBuild({
            files,
            paths,
            apiKey: process.env.E2B_API_KEY?.trim(),
            metadata: { projectId, purpose: "check-build" },
            preview: ownerId ? { projectId, ownerId } : undefined,
          });
        });
      } catch (error) {
        return unfinished(error);
      }
    },
  });
};
