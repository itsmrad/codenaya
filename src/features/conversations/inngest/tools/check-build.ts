import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { CommandExitError, type CommandResult, type Sandbox } from "e2b";

import {
  BUILD_CHECK_UNFINISHED,
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_PASSED,
  buildPathIndex,
} from "@/features/conversations/agent-steps";
import {
  type ProjectFile,
  WORK_DIR,
  createProjectSandbox,
  writeProjectFiles,
} from "@/features/sandbox-preview/server/project-sandbox";
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
}

/** Install, type check and build together must finish within this. */
const CHECK_TIMEOUT_MS = 120_000;
/** E2B reaps the sandbox after this even if the kill below is lost. */
const SANDBOX_TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_LINES = 40;

const ANSI_ESCAPE = /\u001b\[[\d;]*[A-Za-z]/g;

/**
 * The first lines of compiler output, without colour codes, repeated lines or
 * the sandbox's absolute paths, so errors read as `src/App.tsx(3,1): ...`.
 */
export const trimBuildOutput = (output: string) => {
  const lines = [
    ...new Set(
      output
        .replace(ANSI_ESCAPE, "")
        .replaceAll(`${WORK_DIR}/`, "")
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
const run = async (sandbox: Sandbox, command: string, timeoutMs: number): Promise<CommandResult> => {
  try {
    return await sandbox.commands.run(command, { cwd: WORK_DIR, timeoutMs });
  } catch (error) {
    if (error instanceof CommandExitError) return error;
    throw error;
  }
};

/** Errors first: Vite writes progress to stdout and the failure to stderr. */
const failureOutput = (result: CommandResult) =>
  trimBuildOutput(`${result.stderr}\n${result.stdout}`);

/** A timeout or a sandbox failure, not a problem in the project's code. */
const unfinished = (error: unknown) =>
  `${BUILD_CHECK_UNFINISHED} (${error instanceof Error ? error.message : "Unknown error"}). ` +
  "This is not an error in the project's code. Say in Notes that the build was not verified.";

const notBuilt = (reason: string) =>
  `${STATIC_CHECKS_PASSED}\n${reason}, so the type check and build did not run. ` +
  "Say in Notes that the build was not verified.";

/**
 * Static checks, then `npm install`, `tsc --noEmit` and `vite build` in a
 * throwaway sandbox. Returns the tool result: a passing summary, or an
 * "Error: ..." message the agent can act on. Never throws.
 *
 * `paths` holds every project file, including uploads with no text content.
 */
export const checkProjectBuild = async ({
  files,
  paths,
  apiKey,
  metadata,
}: {
  files: ProjectFile[];
  paths: Set<string>;
  apiKey?: string;
  metadata?: Record<string, string>;
}): Promise<string> => {
  const problems = [
    ...missingReferencedFiles(files),
    ...undeclaredPackages(files),
    ...unresolvedImports(files, paths),
  ];
  if (problems.length > 0) {
    return (
      `Error: Static checks failed:\n- ${problems.join("\n- ")}\n` +
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

  let sandbox: Sandbox;
  try {
    sandbox = await createProjectSandbox({ apiKey, timeoutMs: SANDBOX_TIMEOUT_MS, metadata });
  } catch (error) {
    console.error("[check-build] sandbox creation failed", error);
    return notBuilt("The build sandbox could not start");
  }

  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const timeLeft = () => Math.max(1_000, deadline - Date.now());

  try {
    await writeProjectFiles(sandbox, files);

    const install = await run(sandbox, "npm install --no-audit --no-fund --loglevel=error", timeLeft());
    if (install.exitCode !== 0) {
      return `Error: npm install failed. Fix package.json, then call checkBuild again:\n${failureOutput(install)}`;
    }

    const tsconfig = ["tsconfig.app.json", "tsconfig.json"].find((path) => paths.has(path));
    const command = [tsconfig && `npx tsc --noEmit -p ${tsconfig}`, "npx vite build"]
      .filter(Boolean)
      .join(" && ");
    const build = await run(sandbox, command, timeLeft());
    if (build.exitCode !== 0) {
      return `Error: Build failed. Fix these errors, then call checkBuild again:\n${failureOutput(build)}`;
    }

    return `${BUILD_VERIFIED}\nDependencies installed, and the type check and production build passed.`;
  } catch (error) {
    return unfinished(error);
  } finally {
    await sandbox.kill().catch(() => {});
  }
};

export const createCheckBuildTool = ({
  projectId,
  internalKey,
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
          const rows = await convex.query(api.system.getProjectFiles, {
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
          });
        });
      } catch (error) {
        return unfinished(error);
      }
    },
  });
};
