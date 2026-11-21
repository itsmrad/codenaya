import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
// The seam maps E2B's TimeoutError; an aborted request still arrives as E2B's own SandboxError.
import { SandboxError } from "e2b";

import {
  BUILD_CHECK_UNFINISHED,
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  STATIC_CHECKS_PASSED,
  buildPathIndex,
} from "@/features/conversations/agent-steps";
import { resolveProjectEnv, secretValuesFrom } from "@/features/integrations/server/env/resolve-env";
import { redact } from "@/features/integrations/server/env/stream-redactor";
import {
  MAX_LIVE_SANDBOXES,
  type ProjectFile,
  WORK_DIR,
  offlineFirstInstall,
  projectFileEntries,
} from "@/features/sandbox-preview/server/project-sandbox";
import { listAll } from "@/features/sandbox-preview/server/provider/fanout";
import { listCommands, remove, runOrThrow } from "@/features/sandbox-preview/server/provider/helpers";
import { getSandboxPool, type SandboxPool, singleProviderPool } from "@/features/sandbox-preview/server/provider/registry";
import {
  type RunResult,
  type Sandbox,
  type SandboxProvider,
  SandboxTimeoutError,
} from "@/features/sandbox-preview/server/provider/types";
import {
  SHORT_CALL_MS,
  type PreviewDevServer,
  findPreviewDevServer,
  isBootInstall,
  restartDevServerIfDown,
} from "@/features/sandbox-preview/server/dev-server";
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

import { brokenImagesWarning, brokenRemoteImages, remoteImageUrls } from "./remote-images";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { isSecretPath, withoutSecretFiles } from "../../../../../convex/secretFiles";

interface CheckBuildToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  /** Project owner; finds their running preview sandbox to build in (#465). */
  ownerId?: string;
}

/** Install, type check and build together must finish within this; swarm projects build in 115-130 s. */
const CHECK_TIMEOUT_MS = 180_000;
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
/** The provider reaps the sandbox after this even if the kill below is lost. */
const SANDBOX_TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_LINES = 40;
/**
 * A warm preview needs this much time left to be reused, so connecting (which
 * only ever raises the timeout to this) never extends or shortens it.
 */
const WARM_MIN_TIME_LEFT_MS = STEP_BUDGET_MS + 60_000;

/** Build output and generated files kept out of the copy for a framework (Vite's dist is always excluded). */
const GENERATED_PATHS: Partial<Record<Framework, string[]>> = {
  next: [".next", "out", "next-env.d.ts"],
  "tanstack-start": [".output", ".tanstack", ".nitro", ".vinxi"],
};

const ANSI_ESCAPE = /\u001b\[[\d;]*[A-Za-z]/g;

/** `next build` progress, the route table and its legend, and the telemetry notice. */
const NEXT_NOISE =
  /^\s*(?:▲ Next\.js|- (?:Environments?|Experiments)\b|[✓○ƒ●◐λ]\s|[┌├└│]|\+ First Load JS|Route \((?:app|pages)\)|Creating an optimized production build|Compiled (?:successfully|with warnings)|Linting and checking validity of types|Running TypeScript|Finished TypeScript|Collecting page data|Generating static pages|Collecting build traces|Finalizing page optimization|Skipping (?:validation|linting)|Attention: Next\.js now collects|This information is used|You can learn more|https:\/\/nextjs\.org\/telemetry)/;
/** Where a `next build` failure starts. */
const NEXT_ERROR_START =
  /^\s*(?:Failed to compile|Error occurred prerendering page|> Build error occurred|Build error occurred|⨯ |Type error:|Module not found)/;

/**
 * Vite's progress for TanStack Start's client and server builds (the banner, step lines and asset
 * table), and where a failure starts: Vite's `error during build:`, a bracketed plugin or rolldown
 * code, or a tsc error.
 */
const START_NOISE =
  /^\s*(?:vite v\d|transforming\.\.\.|rendering chunks\.\.\.|computing gzip size\.\.\.|✓ (?:\d+ modules transformed|built in)|(?:dist|\.output|\.nitro)\/\S+\s+[\d.,]+ (?:B|kB|MB)\b)/;
const START_ERROR_START = /^\s*(?:error during build:|\[[\w:-]+\]|.*\berror TS\d+)/;

/** Output lines without colour codes, the sandbox's absolute paths or trailing whitespace (`\r` included). */
const cleanLines = (output: string, dir: string) =>
  output.replace(ANSI_ESCAPE, "").replaceAll(`${dir}/`, "").split("\n").map((line) => line.trimEnd());

/**
 * The first lines of compiler output, without colour codes, repeated lines or
 * the sandbox's absolute paths, so errors read as `src/App.tsx(3,1): ...`.
 * For Next.js and TanStack Start, progress is dropped and the errors come first.
 */
export const trimBuildOutput = (output: string, dir = WORK_DIR, framework: Framework = "vite") => {
  let lines = [...new Set(cleanLines(output, dir).filter(Boolean))];
  if (framework === "next" || framework === "tanstack-start") {
    const [noise, errorStart] = framework === "next" ? [NEXT_NOISE, NEXT_ERROR_START] : [START_NOISE, START_ERROR_START];
    lines = lines.filter((line) => !noise.test(line));
    const start = lines.findIndex((line) => errorStart.test(line));
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
  /** Null when unknown: output that could hold a value is then hidden. */
  secrets: readonly string[] | null;
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

/** The result, with its exit code, is what the caller reports. */
const run = (sandbox: Sandbox, command: string, timeoutMs: number, cwd: string) =>
  sandbox.run(command, { cwd, timeoutMs, requestTimeoutMs: timeoutMs });

/**
 * Errors first: Vite writes progress to stdout and the failure to stderr
 * (Next.js output is reordered by `trimBuildOutput`).
 * Secrets are redacted once, before trimming, which could cut a multi-line one;
 * colour codes, paths and `\r` that could split one inside a line are dropped first.
 * Trimming then only drops or reorders whole lines, which can bring a multi-line
 * value's lines together again, so only those values are matched once more: a
 * second pass over every value could match inside the placeholders themselves.
 * Known errors anywhere in the output get their cause and fix appended, unredacted.
 */
const failureOutput = (result: RunResult, dir: string, secrets: readonly string[] | null, framework: Framework) => {
  const output = redact(cleanLines(`${result.stderr}\n${result.stdout}`, dir).join("\n"), secrets);
  const multiLine = secrets && secrets.filter((value) => value.trim().includes("\n"));
  return withErrorHints(redact(trimBuildOutput(output, dir, framework), multiLine), output);
};

/** Where an unfinished check stopped; "step" is a failure outside any build path. */
type Where = {
  path: "warm" | "cold" | "given" | "before-cold" | "warm-then-cold" | "warm-then-before-cold" | "step";
  deadline?: number; sandbox?: Sandbox | null };

/** A timeout or a sandbox failure, not a problem in the project's code. */
const unfinished = (error: unknown, secrets: readonly string[] | null = [], { path, deadline, sandbox }: Where = { path: "step" }) => {
  const reason = redact(error instanceof Error ? error.message : "Unknown error", secrets);
  // One line per unfinished check, so a repeat can be told apart: which path, how long it ran, what was left.
  console.error(
    "[check-build] unfinished",
    JSON.stringify({
      path,
      elapsedMs: deadline && Date.now() - (deadline - STEP_BUDGET_MS),
      budgetLeftMs: deadline && deadline - Date.now(),
      sandboxId: sandbox?.id,
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
 * TanStack Start builds first: `vite build` generates src/routeTree.gen.ts, which tsc needs.
 */
export const buildCommand = (framework: Framework, paths: Set<string>) => {
  if (framework === "next") return "NEXT_TELEMETRY_DISABLED=1 npx next build";
  if (framework === "tanstack-start") return "npx vite build && npx tsc --noEmit";
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

  await sandbox.writeFiles(projectFileEntries(files, dir), { requestTimeoutMs: timeLeft() });
  // Probed alongside the install and build; never rejects.
  const imageUrls = remoteImageUrls(files);
  const brokenImages = imageUrls.size > 0 ? brokenRemoteImages(sandbox, imageUrls, timeLeft()) : Promise.resolve([]);

  const install = await run(sandbox, offlineFirstInstall("--no-audit --no-fund --loglevel=error"), timeLeft(), dir);
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

  const broken = await brokenImages;
  // One pass over all the URLs (none holds a newline), and the warning's own text left as it is.
  const warning = broken.length > 0 ? brokenImagesWarning(redact(broken.join("\n"), secrets).split("\n")) : "";
  return `${BUILD_VERIFIED}\nDependencies installed, and the type check and production build passed.` + notes + warning;
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

/**
 * An install the preview (or another check) runs: copying node_modules now could catch it half-written.
 * A request timeout is inconclusive while the preview is busy installing.
 */
const installRunning = async (sandbox: Sandbox, deadline: number) => {
  const requestTimeoutMs = within(deadline, SHORT_CALL_MS);
  const started = Date.now();
  try {
    return (await listCommands(sandbox, { requestTimeoutMs })).some((proc) => isBootInstall(proc));
  } catch (error) {
    // E2B also uses TimeoutError for expired sandboxes; those must fall cold.
    const requestTimedOut =
      (error instanceof SandboxTimeoutError && !error.message.includes("sandbox timeout")) ||
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
 * The owner's running preview sandbox for this project, on whichever provider
 * runs it, connected through that provider, when it has time left and no install
 * running (waiting a bounded time for one to finish). A failing non-primary
 * provider is skipped, as in the preview lookup. The query filters by the tags
 * the preview route sets; they are checked again here because they decide whose
 * sandbox this runs in.
 */
const connectWarmSandbox = async ({ providers, health }: SandboxPool, { projectId, ownerId }: WarmPreview, deadline: number) => {
  const running = await listAll(providers, {
    metadata: { userId: ownerId, projectId },
    limit: MAX_LIVE_SANDBOXES,
    requestTimeoutMs: within(deadline, SHORT_CALL_MS),
  }, health && { ...health, skip: "failing" });
  // Connect only through a provider in the pool; a preview tagged with any other is skipped.
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const info = running.find(
    (sandbox) =>
      byId.has(sandbox.provider) &&
      sandbox.metadata.userId === ownerId &&
      sandbox.metadata.projectId === projectId &&
      sandbox.endAt.getTime() - Date.now() > WARM_MIN_TIME_LEFT_MS,
  );
  const provider = info && byId.get(info.provider);
  if (!info || !provider) return null;

  const sandbox = await provider.connect(info.id, {
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
  sandbox
    .run(`for p in /proc/[0-9]*; do case "$(readlink "$p/cwd")" in ${dir}|${dir}/*) kill -9 "\${p##*/}";; esac; done; true`, {
      timeoutMs: SHORT_CALL_MS,
      requestTimeoutMs: SHORT_CALL_MS,
    })
    .catch(() => {});

/**
 * The check in the project's warm preview sandbox, or null to use a new one.
 * It builds in its own directory with a copy of the preview's node_modules, so
 * the dev server, its HMR and its installed packages are left alone, and the
 * preview's `.env` is not read, as on the cold path. Never kills the sandbox,
 * and starts the preview's dev server again if the build took it down.
 */
const checkInWarmSandbox = async (pool: SandboxPool, preview: WarmPreview, job: BuildJob): Promise<string | null> => {
  const dir = `/home/user/check-build-${randomUUID().slice(0, 8)}`;
  let sandbox: Sandbox | null = null;
  let building = false;
  let devServer: PreviewDevServer | null = null;
  try {
    sandbox = await connectWarmSandbox(pool, preview, job.deadline);
    if (!sandbox) return null;
    const before = await previewState(sandbox, job.deadline);
    if (before.includes(".env")) return null;
    await runOrThrow(sandbox, `mkdir -p ${dir} && cp -a ${WORK_DIR}/node_modules ${dir}/`, {
      timeoutMs: within(job.deadline, COPY_TIMEOUT_MS),
      requestTimeoutMs: within(job.deadline, COPY_TIMEOUT_MS),
    });
    if ((await previewState(sandbox, job.deadline)) !== before || (await installRunning(sandbox, job.deadline))) {
      return null;
    }

    // Not finding it only skips the restart below; the build still runs warm.
    devServer = await findPreviewDevServer(sandbox, within(job.deadline, SHORT_CALL_MS)).catch(() => null);
    building = true;
    return await buildIn(sandbox, dir, job, "warm");
  } catch (error) {
    // A slow warm build may be the preview's own load (leftovers, the dev server), so a new sandbox gets a try.
    if (building && (error instanceof SandboxTimeoutError || error instanceof OutOfTime)) {
      if (sandbox) await killBuildProcesses(sandbox, dir);
      markWarmSlow(preview.projectId);
      console.error("[check-build] warm build timed out, trying a new sandbox", sandbox?.id, error);
      return null;
    }
    if (error instanceof OutOfTime) return unfinished(error, [], { path: "warm", deadline: job.deadline, sandbox });
    console.error("[check-build] warm sandbox unavailable, starting a new one", error);
    return null;
  } finally {
    // Never kill: this is the user's live preview. Each call is bounded by
    // SHORT_CALL_MS, best effort, and inside the margin STEP_BUDGET_MS leaves.
    await sandbox
      ?.run(`rm -rf ${dir}`, { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS })
      .catch(() => {});
    if (sandbox && devServer) {
      const restarted = await restartDevServerIfDown(sandbox, devServer, SHORT_CALL_MS).catch((error) => {
        console.error("[check-build] could not check the preview's dev server", sandbox?.id, error);
        return false;
      });
      if (restarted) console.warn("[check-build] the warm build took the preview's dev server down; restarted it", sandbox.id);
    }
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
  /**
   * Where the warm preview is looked up and a new sandbox is made: every
   * configured provider, with failover. None (and no `provider`) means no build.
   */
  sandboxes?: SandboxPool;
  /** One provider for both instead, as a probe passes; `sandboxes` wins. */
  provider?: SandboxProvider;
  metadata?: Record<string, string>;
  preview?: WarmPreview;
  /**
   * Build in this caller-owned sandbox, in a directory of its own: no lookup,
   * no new sandbox, never killed. Takes precedence over `preview` and `provider`.
   */
  sandbox?: Sandbox;
  /**
   * With `sandbox`: the project's directory there, copied into the check first
   * (without node_modules, .git, the top-level build output and secret files), so files
   * `files` leaves out, such as uploads, are built too. `files` is then
   * written over the copy.
   */
  sourceDir?: string;
  /**
   * The values any process the check runs could print, redacted from whatever it
   * returns; null when they could not be resolved, which hides that output.
   */
  secrets?: readonly string[] | null;
  /** Finish by this time (epoch ms) when it is sooner than the step's own budget, e.g. a caller's invoke timeout. */
  deadline?: number;
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
  sandboxes,
  provider,
  metadata,
  preview,
  sandbox: suppliedSandbox,
  sourceDir,
  secrets = [],
  deadline = Infinity,
}: CheckOptions): Promise<string> => {
  const problems = [
    ...missingReferencedFiles(files),
    ...undeclaredPackages(files),
    ...unresolvedImports(files, paths),
    ...linksWithoutRoutes(files, paths),
  ];
  if (problems.length > 0) {
    // Only the findings: the prefix must survive a short value that occurs in it.
    return `${STATIC_CHECKS_FAILED}:\n- ${redact(problems.join("\n- "), secrets)}\nFix these, then call checkBuild again.`;
  }

  const advisory = projectChecks(files, paths, undefined, { references: false });
  const notes = advisory.length
    ? `\nAdvisory project checks:\n- ${redact(advisory.map((f) => `[${f.checkId}] ${f.message}`).join("\n- "), secrets)}`
    : "";
  const framework = projectFramework(files, paths);
  if (!framework) {
    return `${BUILD_NOT_CHECKED}\nStatic checks passed. checkBuild only builds Vite and Next.js projects, so this one was not built.` + notes;
  }

  const job: BuildJob = { files, paths, deadline: Math.min(Date.now() + STEP_BUDGET_MS, deadline), secrets, notes, framework };
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
        await runOrThrow(
          suppliedSandbox,
          `mkdir -p ${dir} && tar -C '${sourceDir}' --exclude=node_modules --exclude=.git --exclude=./dist ` +
            (GENERATED_PATHS[framework] ?? []).map((path) => `--exclude=./${path} `).join("") +
            `-cf - . | tar -C ${dir} -xf -`,
          { timeoutMs, requestTimeoutMs: timeoutMs },
        );
        // The secret-file policy, not tar globs, decides what the build may not see.
        const opts = { cwd: dir, timeoutMs, requestTimeoutMs: timeoutMs };
        const copied = await runOrThrow(suppliedSandbox, "find . \\( -type f -o -type l \\) -printf '%P\\n'", opts);
        for (const path of copied.stdout.split("\n").filter(isSecretPath)) await remove(suppliedSandbox, `${dir}/${path}`, opts);
      }
      return await buildIn(suppliedSandbox, dir, job, "given");
    } catch (error) {
      return unfinished(error, secrets, { path: "given", deadline: job.deadline, sandbox: suppliedSandbox });
    } finally {
      // Never kill: the caller owns this sandbox. Only our directory goes.
      await suppliedSandbox
        .run(`rm -rf ${dir}`, { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS })
        .catch(() => {});
    }
  }

  const pool = sandboxes ?? (provider && singleProviderPool(provider));
  if (!pool) {
    return notBuilt("No build sandbox is configured") + notes;
  }

  // Next and Start builds can OOM-kill the dev server in the preview's 1 GiB sandbox: build them alone.
  const warmPreview = framework === "next" || framework === "tanstack-start" ? undefined : preview;
  if (warmPreview) {
    if (!warmWasSlow(warmPreview.projectId)) {
      const warm = await checkInWarmSandbox(pool, warmPreview, job);
      if (warm) return warm;
    }
    if (job.deadline - Date.now() < MIN_COLD_BUILD_MS) {
      const path = warmWasSlow(warmPreview.projectId) ? "warm-then-before-cold" : "before-cold";
      return unfinished(new OutOfTime(), [], { path, deadline: job.deadline });
    }
  }
  const afterSlowWarm = !!warmPreview && warmWasSlow(warmPreview.projectId);

  // No image: each provider's own default, so an E2B template name never reaches another provider.
  let sandbox: Sandbox;
  try {
    sandbox = await pool.create({
      timeoutMs: SANDBOX_TIMEOUT_MS,
      metadata: metadata ?? {},
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
    // The handle's own kill, so it goes to whichever provider made the sandbox.
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
      // Null until resolved, so a failure before then hides the error's text too.
      let secrets: string[] | null = null;
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
          // Opened only to redact them from the result; no sandbox gets them. Unknown
          // (unread or unopened) values stay null, which hides the output instead.
          if (envVars?.length) {
            secrets = await resolveProjectEnv(envVars).then(secretValuesFrom, (error) => {
              console.error("[check-build] could not open the project's secrets to redact", error);
              return null;
            });
          } else if (envVars) {
            secrets = [];
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
            // Names stay in `paths` for the static checks; no sandbox gets a secret file's content.
            files: withoutSecretFiles(files),
            paths,
            sandboxes: getSandboxPool() ?? undefined,
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
