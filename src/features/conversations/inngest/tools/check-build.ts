import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { CommandExitError, type CommandResult, Sandbox, SandboxError, TimeoutError } from "e2b";

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
import { NETWORK_FAILURE } from "@/features/sandbox-preview/utils/app-error";
import { withErrorHints } from "@/features/sandbox-preview/utils/error-recipes";
import { type Framework, detectFramework } from "@/features/sandbox-preview/utils/framework";
import {
  missingReferencedFiles,
  linksWithoutRoutes,
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
/** How long a check waits for the preview's install to finish before building cold. */
const INSTALL_WAIT_MS = 60_000;
const INSTALL_POLL_MS = 2_500;
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

/** `next build` progress, the route table and its legend, and the telemetry notice. */
const NEXT_NOISE =
  /^\s*(?:▲ Next\.js|- (?:Environments?|Experiments)\b|[✓○ƒ●◐λ]\s|[┌├└│]|\+ First Load JS|Route \((?:app|pages)\)|Creating an optimized production build|Compiled (?:successfully|with warnings)|Linting and checking validity of types|Running TypeScript|Collecting page data|Generating static pages|Collecting build traces|Finalizing page optimization|Skipping (?:validation|linting)|Attention: Next\.js now collects|This information is used|You can learn more|https:\/\/nextjs\.org\/telemetry)/;
/** Where a `next build` failure starts. */
const NEXT_ERROR_START =
  /^\s*(?:Failed to compile|Error occurred prerendering page|> Build error occurred|Build error occurred|⨯ |Type error:|Module not found)/;

/**
 * The first lines of compiler output, without colour codes, repeated lines or
 * the sandbox's absolute paths, so errors read as `src/App.tsx(3,1): ...`.
 * For Next.js, progress and the route table are dropped and the errors come first.
 */
export const trimBuildOutput = (output: string, dir = WORK_DIR, framework: Framework = "vite") => {
  let lines = [
    ...new Set(
      output
        .replace(ANSI_ESCAPE, "")
        .replaceAll(`${dir}/`, "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean),
    ),
  ];
  if (framework === "next") {
    lines = lines.filter((line) => !NEXT_NOISE.test(line));
    const start = lines.findIndex((line) => NEXT_ERROR_START.test(line));
    if (start > 0) lines = [...lines.slice(start), ...lines.slice(0, start)];
  }
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
  framework: Framework;
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
export const redact = (text: string, secrets: readonly string[]) => {
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
 * Errors first: Vite writes progress to stdout and the failure to stderr
 * (Next.js output is reordered by `trimBuildOutput`).
 * Secrets are redacted before trimming, which could cut a multi-line one, and
 * after it, since dropping colour codes, `\r` and paths can rejoin one.
 * Known errors anywhere in the output get their cause and fix appended.
 */
const failureOutput = (result: CommandResult, dir: string, secrets: readonly string[], framework: Framework) => {
  const output = redact(`${result.stderr}\n${result.stdout}`, secrets);
  return redact(withErrorHints(trimBuildOutput(output, dir, framework), output), secrets);
};

/** Where an unfinished check stopped; "step" is a failure outside any build path. */
type Where = {
  path: "warm" | "cold" | "given" | "before-cold" | "warm-then-cold" | "warm-then-before-cold" | "step";
  deadline?: number; sandbox?: Sandbox | null };

/** A timeout or a sandbox failure, not a problem in the project's code. */
const unfinished = (error: unknown, secrets: readonly string[] = [], { path, deadline, sandbox }: Where = { path: "step" }) => {
  const reason = redact(error instanceof Error ? error.message : "Unknown error", secrets);
  // One line per unfinished check, so a repeat can be told apart: which path, how long it ran, what was left.
  console.error(
    "[check-build] unfinished",
    JSON.stringify({
      path,
      elapsedMs: deadline && Date.now() - (deadline - STEP_BUDGET_MS),
      budgetLeftMs: deadline && deadline - Date.now(),
      sandboxId: sandbox?.sandboxId,
      error: error instanceof Error ? error.constructor.name : typeof error,
      reason: reason.slice(0, 200),
    }),
  );
  return (
    `${BUILD_CHECK_UNFINISHED} (${reason}). ` +
    "This is not an error in the project's code. Say in Notes that the build was not verified."
  );
};

const notBuilt = (reason: string) =>
  `${STATIC_CHECKS_PASSED}\n${reason}, so the type check and build did not run. ` +
  "Say in Notes that the build was not verified.";

/**
 * The production build: `tsc --noEmit` then `vite build`, or `next build`
 * alone (it type-checks itself, and tsc before it would miss `next-env.d.ts`).
 */
export const buildCommand = (framework: Framework, paths: Set<string>) => {
  if (framework === "next") return "NEXT_TELEMETRY_DISABLED=1 npx next build";
  const tsconfig = ["tsconfig.app.json", "tsconfig.json"].find((path) => paths.has(path));
  return [tsconfig && `npx tsc --noEmit -p ${tsconfig}`, "npx vite build"].filter(Boolean).join(" && ");
};

/**
 * Writes the files to `dir`, then runs `npm install` and the build there,
 * within CHECK_TIMEOUT_MS and the step deadline. Returns the tool result for
 * a finished check; throws on sandbox failures and timeouts.
 */
const buildIn = async (
  sandbox: Sandbox,
  dir: string,
  { files, paths, deadline, secrets, notes, framework }: BuildJob,
  path: Where["path"],
) => {
  const buildDeadline = Math.min(Date.now() + CHECK_TIMEOUT_MS, deadline);
  const timeLeft = () => within(buildDeadline, CHECK_TIMEOUT_MS);

  await writeProjectFiles(sandbox, files, dir, timeLeft);

  const install = await run(sandbox, "npm install --prefer-offline --no-audit --no-fund --loglevel=error", timeLeft(), dir);
  if (install.exitCode !== 0) {
    // The registry or the sandbox's network, not package.json: nothing to fix.
    if (NETWORK_FAILURE.test(`${install.stderr}\n${install.stdout}`)) {
      return unfinished(new Error("npm could not reach the package registry"), [], { path, deadline, sandbox });
    }
    return `Error: npm install failed. Fix package.json, then call checkBuild again:\n${failureOutput(install, dir, secrets, framework)}`;
  }

  const build = await run(sandbox, buildCommand(framework, paths), timeLeft(), dir);
  if (build.exitCode !== 0) {
    return `Error: Build failed. Fix these errors, then call checkBuild again:\n${failureOutput(build, dir, secrets, framework)}`;
  }

  return `${BUILD_VERIFIED}\nDependencies installed, and the type check and production build passed.` + notes;
};

/** How long a project's check skips its warm preview after the warm build timed out. */
const WARM_SLOW_TTL_MS = 10 * 60_000;
const WARM_SLOW_MAX = 200;
/**
 * Projects whose warm build timed out, and when. The gate's retry is a new step that
 * would find the same slow preview, so it goes straight to a new sandbox.
 * shortcut: per server instance, so a retry on another instance tries warm once more.
 */
/** Exported so tests can reset it. */
export const warmSlow = new Map<string, number>();

const warmWasSlow = (projectId: string) => {
  const at = warmSlow.get(projectId);
  if (at !== undefined && Date.now() - at >= WARM_SLOW_TTL_MS) warmSlow.delete(projectId);
  return warmSlow.has(projectId);
};

const markWarmSlow = (projectId: string) => {
  warmSlow.delete(projectId);
  warmSlow.set(projectId, Date.now());
  if (warmSlow.size > WARM_SLOW_MAX) warmSlow.delete(warmSlow.keys().next().value!);
};

/** The project whose running preview a check may build in, and its owner. */
type WarmPreview = { projectId: string; ownerId: string };

/** An install the preview (or another check) is running; copying node_modules now could catch it half-written. */
const INSTALLING = /\b(?:npm|pnpm|yarn|bun)\b.*\s(?:install|i|add|ci)(?:\s|$)/;

/** A request timeout is inconclusive while the preview is busy installing. */
const installRunning = async (sandbox: Sandbox, deadline: number) => {
  const requestTimeoutMs = within(deadline, SHORT_CALL_MS);
  const started = Date.now();
  try {
    return (await sandbox.commands.list({ requestTimeoutMs })).some((proc) =>
      INSTALLING.test([proc.cmd, ...proc.args].join(" ")),
    );
  } catch (error) {
    // E2B also uses TimeoutError for expired sandboxes; those must fall cold.
    const requestTimedOut =
      (error instanceof TimeoutError && !error.message.includes("sandbox timeout")) ||
      (error instanceof SandboxError && error.message.includes("The operation was aborted due to timeout"));
    if (requestTimedOut && Date.now() - started >= requestTimeoutMs - Math.min(1_000, requestTimeoutMs / 10)) {
      return true;
    }
    throw error;
  }
};

/**
 * Polls until no install is running: true once none is, false if one still is
 * (or the list keeps timing out) after INSTALL_WAIT_MS or near the step deadline.
 * Each poll is bounded by the wait too.
 */
const installFinished = async (sandbox: Sandbox, deadline: number) => {
  const waitUntil = Math.min(Date.now() + INSTALL_WAIT_MS, deadline);
  try {
    while (await installRunning(sandbox, waitUntil)) {
      if (waitUntil - Date.now() < INSTALL_POLL_MS) return false;
      await new Promise((resolve) => setTimeout(resolve, INSTALL_POLL_MS));
    }
    return true;
  } catch (error) {
    if (error instanceof OutOfTime) return false;
    throw error;
  }
};

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
 * time left and no install running (waiting a bounded time for one to finish).
 * The query filters by the tags the preview route sets; they are checked again
 * here because they decide whose sandbox this runs in.
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
  return (await installFinished(sandbox, deadline)) ? sandbox : null;
};

/**
 * Best effort: SIGKILL whatever runs in the check's own directory. A command that
 * times out may only be disconnected from, leaving its build running in the preview.
 * The dev server runs in WORK_DIR, so it is left alone.
 */
const killBuildProcesses = (sandbox: Sandbox, dir: string) =>
  sandbox.commands
    .run(`for p in /proc/[0-9]*; do case "$(readlink "$p/cwd")" in ${dir}|${dir}/*) kill -9 "\${p##*/}";; esac; done; true`, {
      timeoutMs: SHORT_CALL_MS,
      requestTimeoutMs: SHORT_CALL_MS,
    })
    .catch(() => {});

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
    return await buildIn(sandbox, dir, job, "warm");
  } catch (error) {
    // A slow warm build may be the preview's own load (leftovers, the dev server), so a new sandbox gets a try.
    if (building && (error instanceof TimeoutError || error instanceof OutOfTime)) {
      if (sandbox) await killBuildProcesses(sandbox, dir);
      markWarmSlow(preview.projectId);
      console.error("[check-build] warm build timed out, trying a new sandbox", sandbox?.sandboxId, error);
      return null;
    }
    if (error instanceof OutOfTime) return unfinished(error, [], { path: "warm", deadline: job.deadline, sandbox });
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

/** The framework checkBuild builds a project with, from its paths and package.json; null when it builds none. */
export const projectFramework = (files: ProjectFile[], paths: Iterable<string>) => {
  const pkg = files.find((file) => file.path === "package.json")?.content;
  try {
    return detectFramework(paths, pkg ? JSON.parse(pkg) : null);
  } catch {
    return detectFramework(paths); // Invalid package.json: npm install reports it.
  }
};

/** A relative path that stays inside the directory it is joined to. */
export const isSafeProjectPath = (path: string) =>
  !!path && !path.startsWith("/") && !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

type CheckOptions = {
  files: ProjectFile[];
  paths: Set<string>;
  apiKey?: string;
  metadata?: Record<string, string>;
  preview?: WarmPreview;
  /**
   * Build in this caller-owned sandbox, in a directory of its own: no lookup,
   * no new sandbox, never killed. Takes precedence over `preview` and `apiKey`.
   */
  sandbox?: Sandbox;
  /**
   * With `sandbox`: the project's directory there, copied into the check first
   * (without node_modules, .git, the top-level build output and .env files), so files
   * `files` leaves out, such as uploads, are built too. `files` is then
   * written over the copy.
   */
  sourceDir?: string;
  /** The project's secret values, redacted from whatever the check returns. */
  secrets?: string[];
};

/**
 * Static checks, then `npm install` and the Vite or Next.js build: in the
 * given `sandbox`, else the owner's running preview sandbox when there is one,
 * else a throwaway sandbox. Returns the tool result, with `secrets` redacted from the raw
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
  sandbox: suppliedSandbox,
  sourceDir,
  secrets = [],
}: CheckOptions): Promise<string> => {
  const problems = [
    ...missingReferencedFiles(files),
    ...undeclaredPackages(files),
    ...unresolvedImports(files, paths),
    ...linksWithoutRoutes(files, paths),
  ];
  if (problems.length > 0) {
    return (
      redact(`${STATIC_CHECKS_FAILED}:\n- ${problems.join("\n- ")}\n` +
      "Fix these, then call checkBuild again.", secrets)
    );
  }

  const advisory = projectChecks(files, paths, undefined, { references: false });
  const notes = advisory.length ? redact(`\nAdvisory project checks:\n- ${advisory.map((f) => `[${f.checkId}] ${f.message}`).join("\n- ")}`, secrets) : "";
  const framework = projectFramework(files, paths);
  if (!framework) {
    return `${BUILD_NOT_CHECKED}\nStatic checks passed. checkBuild only builds Vite and Next.js projects, so this one was not built.` + notes;
  }

  const job: BuildJob = { files, paths, deadline: Date.now() + STEP_BUDGET_MS, secrets, notes, framework };
  if (suppliedSandbox) {
    // Snapshot files must stay inside this check's directory.
    if (!files.every(({ path }) => isSafeProjectPath(path))) {
      return `${STATIC_CHECKS_FAILED}: Invalid project file path.`;
    }
    const dir = `/home/user/check-build-${randomUUID()}`;
    try {
      if (sourceDir) {
        const timeoutMs = within(job.deadline, COPY_TIMEOUT_MS);
        // Anchored like the snapshot's skip list: a nested dist, such as public/dist, is project files.
        await suppliedSandbox.commands.run(
          `mkdir -p ${dir} && tar -C '${sourceDir}' --exclude=node_modules --exclude=.git --exclude=./dist ` +
            (framework === "next" ? "--exclude=./.next --exclude=./out --exclude=./next-env.d.ts " : "") +
            `--exclude=.env --exclude='.env.*' -cf - . | tar -C ${dir} -xf -`,
          { timeoutMs, requestTimeoutMs: timeoutMs },
        );
      }
      return await buildIn(suppliedSandbox, dir, job, "given");
    } catch (error) {
      return unfinished(error, secrets, { path: "given", deadline: job.deadline, sandbox: suppliedSandbox });
    } finally {
      // Never kill: the caller owns this sandbox. Only our directory goes.
      await suppliedSandbox.commands
        .run(`rm -rf ${dir}`, { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS })
        .catch(() => {});
    }
  }

  if (!apiKey) {
    return notBuilt("No build sandbox is configured") + notes;
  }

  if (preview) {
    if (!warmWasSlow(preview.projectId)) {
      const warm = await checkInWarmSandbox(apiKey, preview, job);
      if (warm) return warm;
    }
    if (job.deadline - Date.now() < MIN_COLD_BUILD_MS) {
      const path = warmWasSlow(preview.projectId) ? "warm-then-before-cold" : "before-cold";
      return unfinished(new OutOfTime(), [], { path, deadline: job.deadline });
    }
  }
  const afterSlowWarm = !!preview && warmWasSlow(preview.projectId);

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
    return await buildIn(sandbox, WORK_DIR, job, "cold");
  } catch (error) {
    return unfinished(error, secrets, { path: afterSlowWarm ? "warm-then-cold" : "cold", deadline: job.deadline, sandbox });
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
      "Check that the project builds: looks for missing files, undeclared packages and broken imports, then installs dependencies and runs the TypeScript check and the production build (Vite or Next.js) in a sandbox. " +
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
