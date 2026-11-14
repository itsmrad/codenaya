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
import { resolveProjectEnv, secretValuesFrom } from "@/features/integrations/server/env/resolve-env";
import { createStreamRedactor } from "@/features/integrations/server/env/stream-redactor";
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
import { projectChecks } from "@/features/sandbox-preview/utils/project-checks";
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
/**
 * The warm attempt and the cold fallback together. The Inngest route sets no
 * maxDuration, so the step runs under Vercel's default 300 s; this leaves room
 * for creating the cold sandbox and the Convex reads.
 */
const STEP_BUDGET_MS = 240_000;
/** A cold fallback with less time left than this could not finish a build. */
const MIN_COLD_BUILD_MS = 60_000;
/** Copying the preview's node_modules; seconds for the starter. */
const COPY_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 30_000;
/** Listing, connecting, process lists, state reads and cleanup. */
const SHORT_CALL_MS = 10_000;
/** E2B reaps the sandbox after this even if the kill below is lost. */
const SANDBOX_TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_LINES = 40;
/**
 * A warm preview needs this much time left to be reused, so connecting (which
 * only ever raises the timeout to this) never extends or shortens it.
 */
const WARM_MIN_TIME_LEFT_MS = STEP_BUDGET_MS + 60_000;

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

/** One check: its files, the step deadline it must finish by, and the secrets to redact. */
type BuildJob = {
  files: ProjectFile[];
  /** Every project file, including uploads with no text content. */
  paths: Set<string>;
  deadline: number;
  secrets: readonly string[];
  /** Advisory findings appended to a passing result (#333). */
  notes: string;
};

/** The step budget ran out; reported as an unfinished check. */
class OutOfTime extends Error {
  constructor() {
    super("The check ran out of time");
  }
}

/** `cap`, or the time left before `deadline` if that is shorter. Throws once it is spent. */
const within = (deadline: number, cap: number) => {
  const left = Math.min(cap, deadline - Date.now());
  if (left <= 0) throw new OutOfTime();
  return left;
};

/** The preview route's secret redaction, over a whole text rather than a stream. */
const redact = (text: string, secrets: readonly string[]) => {
  const redactor = createStreamRedactor(secrets);
  return redactor.push(text) + redactor.flush();
};

/** E2B throws on a non-zero exit; the result is what the caller reports. */
const run = async (
  sandbox: Sandbox,
  command: string,
  timeoutMs: number,
  cwd: string,
): Promise<CommandResult> => {
  try {
    return await sandbox.commands.run(command, { cwd, timeoutMs, requestTimeoutMs: timeoutMs });
  } catch (error) {
    if (error instanceof CommandExitError) return error;
    throw error;
  }
};

/**
 * Errors first: Vite writes progress to stdout and the failure to stderr.
 * Secrets are redacted before trimming, which could cut a multi-line one, and
 * after it, since dropping colour codes, `\r` and paths can rejoin one.
 * Known errors anywhere in the output get their cause and fix appended.
 */
const failureOutput = (result: CommandResult, dir: string, secrets: readonly string[]) => {
  const output = redact(`${result.stderr}\n${result.stdout}`, secrets);
  return redact(withErrorHints(trimBuildOutput(output, dir), output), secrets);
};

/** A timeout or a sandbox failure, not a problem in the project's code. */
const unfinished = (error: unknown, secrets: readonly string[] = []) =>
  `${BUILD_CHECK_UNFINISHED} (${redact(error instanceof Error ? error.message : "Unknown error", secrets)}). ` +
  "This is not an error in the project's code. Say in Notes that the build was not verified.";

const notBuilt = (reason: string) =>
  `${STATIC_CHECKS_PASSED}\n${reason}, so the type check and build did not run. ` +
  "Say in Notes that the build was not verified.";

/**
 * Writes the files to `dir`, then runs `npm install`, `tsc --noEmit` and
 * `vite build` there, within CHECK_TIMEOUT_MS and the step deadline. Returns
 * the tool result for a finished check; throws on sandbox failures and timeouts.
 */
const buildIn = async (sandbox: Sandbox, dir: string, { files, paths, deadline, secrets, notes }: BuildJob) => {
  const buildDeadline = Math.min(Date.now() + CHECK_TIMEOUT_MS, deadline);
  const timeLeft = () => within(buildDeadline, CHECK_TIMEOUT_MS);

  await writeProjectFiles(sandbox, files, dir, timeLeft);

  const install = await run(sandbox, "npm install --prefer-offline --no-audit --no-fund --loglevel=error", timeLeft(), dir);
  if (install.exitCode !== 0) {
    return `Error: npm install failed. Fix package.json, then call checkBuild again:\n${failureOutput(install, dir, secrets)}`;
  }

  const tsconfig = ["tsconfig.app.json", "tsconfig.json"].find((path) => paths.has(path));
  const command = [tsconfig && `npx tsc --noEmit -p ${tsconfig}`, "npx vite build"]
    .filter(Boolean)
    .join(" && ");
  const build = await run(sandbox, command, timeLeft(), dir);
  if (build.exitCode !== 0) {
    return `Error: Build failed. Fix these errors, then call checkBuild again:\n${failureOutput(build, dir, secrets)}`;
  }

  return `${BUILD_VERIFIED}\nDependencies installed, and the type check and production build passed.` + notes;
};

/** The project whose running preview a check may build in, and its owner. */
type WarmPreview = { projectId: string; ownerId: string };

/** An install the preview (or another check) is running; copying node_modules now could catch it half-written. */
const INSTALLING = /\b(?:npm|pnpm|yarn|bun)\b.*\s(?:install|i|add|ci)(?:\s|$)/;

const installRunning = async (sandbox: Sandbox, deadline: number) =>
  (await sandbox.commands.list({ requestTimeoutMs: within(deadline, SHORT_CALL_MS) })).some((proc) =>
    INSTALLING.test([proc.cmd, ...proc.args].join(" ")),
  );

/**
 * What an install changes, and any `.env` the preview was given (it can outlive
 * the project's variables). Read before and after the copy: a difference means
 * an install ran in between, which the process list alone can miss.
 */
const PREVIEW_STATE =
  "stat -c '%n %y' package.json package-lock.json pnpm-lock.yaml yarn.lock bun.lockb " +
  "node_modules node_modules/.package-lock.json .env .env.local 2>/dev/null; " +
  "md5sum package.json package-lock.json 2>/dev/null; true";

const previewState = async (sandbox: Sandbox, deadline: number) =>
  (await run(sandbox, PREVIEW_STATE, within(deadline, SHORT_CALL_MS), WORK_DIR)).stdout;

/**
 * The owner's running preview sandbox for this project, connected, when it has
 * time left and no install running. The query filters by the tags the preview
 * route sets; they are checked again here because they decide whose sandbox
 * this runs in.
 */
const connectWarmSandbox = async (apiKey: string, { projectId, ownerId }: WarmPreview, deadline: number) => {
  const running = await Sandbox.list({
    apiKey,
    query: { metadata: { userId: ownerId, projectId }, state: ["running"] },
    limit: MAX_LIVE_SANDBOXES,
    requestTimeoutMs: within(deadline, SHORT_CALL_MS),
  }).nextItems();
  const info = running.find(
    (sandbox) =>
      sandbox.metadata.userId === ownerId &&
      sandbox.metadata.projectId === projectId &&
      sandbox.endAt.getTime() - Date.now() > WARM_MIN_TIME_LEFT_MS,
  );
  if (!info) return null;

  const sandbox = await Sandbox.connect(info.sandboxId, {
    apiKey,
    timeoutMs: WARM_MIN_TIME_LEFT_MS,
    requestTimeoutMs: within(deadline, SHORT_CALL_MS),
  });
  return (await installRunning(sandbox, deadline)) ? null : sandbox;
};

/**
 * The check in the project's warm preview sandbox, or null to use a new one.
 * It builds in its own directory with a copy of the preview's node_modules, so
 * the dev server, its HMR and its installed packages are left alone, and the
 * preview's `.env` is not read, as on the cold path. Never kills the sandbox.
 */
const checkInWarmSandbox = async (apiKey: string, preview: WarmPreview, job: BuildJob): Promise<string | null> => {
  const dir = `/home/user/check-build-${randomUUID().slice(0, 8)}`;
  let sandbox: Sandbox | null = null;
  let building = false;
  try {
    sandbox = await connectWarmSandbox(apiKey, preview, job.deadline);
    if (!sandbox) return null;
    const before = await previewState(sandbox, job.deadline);
    if (before.includes(".env")) return null;
    await sandbox.commands.run(`mkdir -p ${dir} && cp -a ${WORK_DIR}/node_modules ${dir}/`, {
      timeoutMs: within(job.deadline, COPY_TIMEOUT_MS),
      requestTimeoutMs: within(job.deadline, COPY_TIMEOUT_MS),
    });
    if ((await previewState(sandbox, job.deadline)) !== before || (await installRunning(sandbox, job.deadline))) {
      return null;
    }

    building = true;
    return await buildIn(sandbox, dir, job);
  } catch (error) {
    if (error instanceof OutOfTime) return unfinished(error);
    // A slow build would time out in a new sandbox too.
    if (building && error instanceof TimeoutError) return unfinished(error, job.secrets);
    console.error("[check-build] warm sandbox unavailable, starting a new one", error);
    return null;
  } finally {
    // Never kill: this is the user's live preview. Bounded, best effort, and
    // inside the margin STEP_BUDGET_MS leaves.
    await sandbox
      ?.commands.run(`rm -rf ${dir}`, { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS })
      .catch(() => {});
  }
};

type CheckOptions = {
  files: ProjectFile[];
  paths: Set<string>;
  apiKey?: string;
  metadata?: Record<string, string>;
  preview?: WarmPreview;
  /** The project's secret values, redacted from whatever the check returns. */
  secrets?: string[];
};

/**
 * Static checks, then `npm install`, `tsc --noEmit` and `vite build`: in the
 * owner's running preview sandbox when there is one, else in a throwaway
 * sandbox. Returns the tool result, with `secrets` redacted from the raw
 * output before it is trimmed: a passing summary, or an "Error: ..." message
 * the agent can act on. Never throws.
 *
 * `paths` holds every project file, including uploads with no text content.
 */
export const checkProjectBuild = async ({
  files,
  paths,
  apiKey,
  metadata,
  preview,
  secrets = [],
}: CheckOptions): Promise<string> => {
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

  const advisory = projectChecks(files, paths, undefined, { references: false });
  const notes = advisory.length ? redact(`\nAdvisory project checks:\n- ${advisory.map((f) => `[${f.checkId}] ${f.message}`).join("\n- ")}`, secrets) : "";
  const isVite =
    paths.has("package.json") && [...paths].some((path) => /^vite\.config\.[cm]?[jt]s$/.test(path));
  if (!isVite) {
    return `${BUILD_NOT_CHECKED}\nStatic checks passed. checkBuild only builds Vite projects, so this one was not built.` + notes;
  }

  if (!apiKey) {
    return notBuilt("No build sandbox is configured") + notes;
  }

  const job: BuildJob = { files, paths, deadline: Date.now() + STEP_BUDGET_MS, secrets, notes };
  if (preview) {
    const warm = await checkInWarmSandbox(apiKey, preview, job);
    if (warm) return warm;
    if (job.deadline - Date.now() < MIN_COLD_BUILD_MS) return unfinished(new OutOfTime());
  }

  let sandbox: Sandbox;
  try {
    sandbox = await createProjectSandbox({
      apiKey,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      metadata,
      requestTimeoutMs: within(job.deadline, CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[check-build] sandbox creation failed", error);
    return notBuilt("The build sandbox could not start") + notes;
  }

  try {
    return await buildIn(sandbox, WORK_DIR, job);
  } catch (error) {
    return unfinished(error, secrets);
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
      let secrets: string[] = [];
      try {
        return await toolStep?.run("check-build", async () => {
          // The metadata list has no text since #412; this one carries it.
          const [rows, envVars] = await Promise.all([
            convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId }),
            // Null when unknown; the check then builds cold, where no variables are written.
            convex.query(api.system.getEnvVarsForSandbox, { internalKey, projectId }).catch((error) => {
              console.error("[check-build] could not read the project's variables", error);
              return null;
            }),
          ]);
          // Opened only to redact them from the result; no sandbox gets them.
          if (envVars?.length) {
            secrets = await resolveProjectEnv(envVars).then(secretValuesFrom, (error) => {
              console.error("[check-build] could not open the project's secrets to redact", error);
              return [];
            });
          }
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
            secrets,
            // The preview's sandbox has these variables in .env, where install
            // scripts and vite.config could read them into the output.
            preview: ownerId && envVars?.length === 0 ? { projectId, ownerId } : undefined,
          });
        });
      } catch (error) {
        return unfinished(error, secrets);
      }
    },
  });
};
