import { createAgent, createNetwork, createTool } from "@inngest/agent-kit";
import type { Sandbox } from "e2b";
import { z } from "zod";

import { BUILD_CHECK_UNFINISHED, BUILD_VERIFIED, STATIC_CHECKS_FAILED } from "@/features/conversations/agent-steps";
import { checkProjectBuild, isSafeProjectPath, redact } from "@/features/conversations/inngest/tools/check-build";
import { type ProjectFile, WORK_DIR } from "@/features/sandbox-preview/server/project-sandbox";

/**
 * Build check and model repair for one caller-owned sandbox (SWARM workers
 * and the integration sandbox). The single-agent chat run keeps its own
 * checkBuild tool and build gate; this does not replace them.
 *
 * Each verify reads a fresh snapshot of `dir` and builds it in a directory of
 * its own (`checkProjectBuild` with `sandbox`), so writes landing meanwhile
 * never mix into a half-copied tree. The sandbox is never looked up, created
 * or killed here. A pass proves install, type check and production build
 * only: runtime errors in the preview are not checked.
 *
 * Example, in an Inngest function body (not inside `step.run`, since the
 * repair agent's model calls and writes are steps of their own):
 *
 *   const result = await verifyAndFix({
 *     sandbox, projectId, runId: event.data.runId, agentTaskId: task.id,
 *     model: buildAgentKitModel({ provider: "anthropic", apiKey, model: "claude-haiku-5-5" }),
 *     secrets,
 *     step: (id, fn) => step.run(id, fn),
 *     onEvent: (e) => recordTrail({ ...e, subAgentId: task.id }),
 *   });
 *   // result is plain JSON: { ok, status, errors, filesChanged, attempts, reason? }
 */

/** Repairs after the first check; each is followed by a fresh check. */
export const MAX_REPAIR_ATTEMPTS = 3;
/** Model turns one repair may take (reads, writes, final line). */
const REPAIR_MAX_STEPS = 8;
/** Larger files count as present but are not copied into the check. */
const MAX_TEXT_BYTES = 1_000_000;
const MAX_SNAPSHOT_FILES = 2_000;
const SHORT_CALL_MS = 10_000;
/** Never read into a check or shown to the model, like the preview's `.env` on the warm path. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);
const isEnvFile = (path: string) => /(^|\/)\.env(\.|$)/.test(path);
const readable = (path: string) =>
  isSafeProjectPath(path) && !SKIPPED_DIRS.has(path.split("/")[0]) && !isEnvFile(path);

export type BuildErrorKind = "static" | "install" | "type" | "build";
export type BuildError = { file?: string; line?: number; message: string; kind: BuildErrorKind };

export type RepairEvent = {
  /** Stable across Inngest replays: upsert by it. */
  id: string;
  phase: "verify" | "repair";
  attempt: number;
  status: "running" | "done" | "error";
  errors?: BuildError[];
  filesChanged?: string[];
  reason?: string;
};

export type RepairResult = {
  /** True only for a full, unfiltered pass. */
  ok: boolean;
  /**
   * verified: the full build passed. scoped-ok: only errors `filterErrors`
   * dropped remain, so the full build still fails. failed: errors left after
   * the repairs. unverified: the check could not run, or was cancelled.
   */
  status: "verified" | "scoped-ok" | "failed" | "unverified";
  /** The last check's errors, unfiltered. */
  errors: BuildError[];
  filesChanged: string[];
  /** Repairs run. */
  attempts: number;
  reason?: string;
};

/** One verify's outcome: plain JSON, so a step can memoize it. */
type CheckOutcome = { status: "passed" | "failed" | "unverified"; errors: BuildError[]; paths: string[]; reason?: string };

type Model = NonNullable<Parameters<typeof createAgent>[0]["model"]>;

export type VerifyAndFixOptions = {
  /** Caller-owned and left running. */
  sandbox: Sandbox;
  /** The project's directory in the sandbox. */
  dir?: string;
  projectId: string;
  runId: string;
  /** Tells parallel workers' step and event ids apart. */
  agentTaskId?: string;
  /** The repair agent's model, built by the caller (`buildAgentKitModel`). */
  model: Model;
  /** Capped at MAX_REPAIR_ATTEMPTS. */
  maxAttempts?: number;
  /** Keep the errors this worker owns; what it drops can only yield `scoped-ok`. */
  filterErrors?: (errors: BuildError[]) => BuildError[];
  /**
   * Checked before each check and repair, by the repair agent's router and by
   * its write tool. An in-flight check or model request is not interrupted:
   * cancelling waits for it, bounded by the check's 240 s budget or the
   * model's request time. The sandbox is never killed to abort.
   */
  signal?: AbortSignal;
  /** Redacted from every error, event and result. */
  secrets?: string[];
  onEvent?: (event: RepairEvent) => void | Promise<void>;
  /** Runs each verify as a durable step, `<runId>:<agentTaskId>:verify:<n>`. */
  step?: (id: string, fn: () => Promise<CheckOutcome>) => Promise<CheckOutcome>;
};

/** The project's files under `dir`: text ones with content, all by path. */
const snapshot = async (sandbox: Sandbox, dir: string) => {
  // GNU find: "<bytes> <relative path>" per file.
  const listing = await sandbox.commands.run(
    "find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -printf '%s %P\\n'",
    { cwd: dir, timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS },
  );
  const entries = listing.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return { size: Number(line.slice(0, space)), path: line.slice(space + 1) };
    })
    .filter(({ path }) => readable(path));
  if (entries.length > MAX_SNAPSHOT_FILES) throw new Error(`More than ${MAX_SNAPSHOT_FILES} project files`);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  // shortcut: one read per file; batch them if large projects make this slow.
  const files = await Promise.all(
    entries
      .filter(({ size }) => size <= MAX_TEXT_BYTES)
      .map(async ({ path }): Promise<ProjectFile | null> => {
        const bytes = await sandbox.files.read(`${dir}/${path}`, {
          format: "bytes",
          requestTimeoutMs: SHORT_CALL_MS,
        });
        try {
          return { path, content: decoder.decode(bytes) };
        } catch {
          return null; // Binary: present by path only, as uploads are in checkBuild.
        }
      }),
  );
  return {
    files: files.filter((file): file is ProjectFile => file !== null),
    paths: new Set(entries.map(({ path }) => path)),
  };
};

// "src/App.tsx(3,7): error TS2322: ..." (tsc) or "src/App.tsx:3:7: ERROR: ..." (esbuild).
const LOCATED = /^([\w@./-]+\.[\w]+)(?:\((\d+),\d+\)|:(\d+):\d+):?\s*(.+)$/;

/** checkBuild's failure text as structured errors; the whole body when no line names a file. */
export const parseBuildErrors = (text: string): BuildError[] => {
  const [head, ...body] = text.split("\n");
  if (head.startsWith(STATIC_CHECKS_FAILED)) {
    const listed = body.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    return (listed.length ? listed : [head]).map((message) => ({ message, kind: "static" }));
  }
  const install = head.startsWith("Error: npm install failed");
  const located = body.flatMap((line): BuildError[] => {
    const match = LOCATED.exec(line);
    if (!match) return [];
    const [, file, tscLine, esLine, message] = match;
    return [{
      file,
      line: Number(tscLine ?? esLine),
      message,
      kind: install ? "install" : /\berror TS\d+/.test(message) ? "type" : "build",
    }];
  });
  return located.length
    ? located
    : [{ message: body.join("\n") || head, kind: install ? "install" : "build" }];
};

const verify = async (sandbox: Sandbox, dir: string, secrets: string[]): Promise<CheckOutcome> => {
  let snap;
  try {
    snap = await snapshot(sandbox, dir);
  } catch (error) {
    const reason = `Could not read the sandbox's files (${error instanceof Error ? error.message : "unknown error"})`;
    return { status: "unverified", errors: [], paths: [], reason: redact(reason, secrets) };
  }
  const text = await checkProjectBuild({ files: snap.files, paths: snap.paths, sandbox, secrets });
  const paths = [...snap.paths];
  if (text.startsWith(BUILD_VERIFIED)) return { status: "passed", errors: [], paths };
  // Anything else that is not an error (Build not checked) or an unfinished
  // check is a sandbox or project-type limit, never a code problem to repair.
  if (!text.startsWith("Error:") || text.startsWith(BUILD_CHECK_UNFINISHED)) {
    return { status: "unverified", errors: [], paths, reason: text.split("\n")[0] };
  }
  return { status: "failed", errors: parseBuildErrors(text), paths };
};

const REPAIR_SYSTEM =
  "You fix build errors in a Vite + TypeScript project inside a sandbox. Read the files you need with readFiles, " +
  "then write each fixed file whole with writeFile. Make the smallest change that fixes the listed errors and change " +
  "nothing else. When done, reply with one line saying what you changed.";

/** Runs the repair agent once; returns the files it changed. */
const repair = async ({
  sandbox, dir, model, name, errors, paths, signal,
}: {
  sandbox: Sandbox;
  dir: string;
  model: Model;
  name: string;
  errors: BuildError[];
  paths: string[];
  signal?: AbortSignal;
}) => {
  const changed = new Set<string>();
  const readFiles = createTool({
    name: "readFiles",
    description: 'Read project files by relative path, like "src/App.tsx".',
    parameters: z.object({ paths: z.array(z.string()).min(1).max(20) }),
    handler: async ({ paths: wanted }) =>
      Promise.all(
        wanted.map(async (path) => {
          if (!readable(path)) return { path, error: "Not readable" };
          const content = await sandbox.files
            .read(`${dir}/${path}`, { requestTimeoutMs: SHORT_CALL_MS })
            .catch(() => undefined);
          return content === undefined ? { path, error: "Not found" } : { path, content };
        }),
      ),
  });
  const writeFile = createTool({
    name: "writeFile",
    description: "Write a whole project file (creates it if missing).",
    parameters: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path, content }, { step }) => {
      if (signal?.aborted) return "Error: Cancelled";
      if (!readable(path)) return `Error: ${path} cannot be written`;
      const write = async () => {
        const current = await sandbox.files
          .read(`${dir}/${path}`, { requestTimeoutMs: SHORT_CALL_MS })
          .catch(() => undefined);
        if (current === content) return false;
        await sandbox.files.write(`${dir}/${path}`, content, { requestTimeoutMs: SHORT_CALL_MS });
        return true;
      };
      // A step, so a replay neither writes again nor forgets the write.
      const wrote = step ? await step.run(`${name}:write:${path}`, write) : await write();
      if (wrote) changed.add(path);
      return wrote ? `Wrote ${path}` : `${path} already had this content`;
    },
  });

  const agent = createAgent({ name, system: REPAIR_SYSTEM, model, tools: [readFiles, writeFile] });
  const network = createNetwork({
    name,
    agents: [agent],
    defaultModel: model,
    maxIter: REPAIR_MAX_STEPS,
    // Until a reply with no tool calls, or the caller cancels.
    router: ({ network: { state } }) => {
      const last = state.results.at(-1);
      if (signal?.aborted) return undefined;
      return !last || last.output.some((message) => message.type === "tool_call") ? agent : undefined;
    },
  });
  const listed = errors.map(({ file, line, message }) =>
    `- ${file ? `${file}${line ? `:${line}` : ""}: ` : ""}${message}`,
  );
  await network.run(
    `The build check failed with:\n${listed.join("\n")}\n\nProject files:\n${paths.slice(0, 300).join("\n")}`,
  );
  return [...changed];
};

/**
 * Checks the project in `sandbox` and, while it fails on code, has the model
 * repair it and checks again, up to `maxAttempts` repairs. Never throws.
 */
export const verifyAndFix = async ({
  sandbox,
  dir = WORK_DIR,
  projectId,
  runId,
  agentTaskId = "main",
  model,
  maxAttempts = MAX_REPAIR_ATTEMPTS,
  filterErrors,
  signal,
  secrets = [],
  onEvent,
  step,
}: VerifyAndFixOptions): Promise<RepairResult> => {
  const prefix = `${runId}:${agentTaskId}`;
  const cap = Math.max(0, Math.min(maxAttempts, MAX_REPAIR_ATTEMPTS));
  const filesChanged = new Set<string>();
  let errors: BuildError[] = [];
  let attempts = 0;

  const emit = async (event: Omit<RepairEvent, "id">) => {
    await onEvent?.({ id: `${prefix}:${event.phase}:${event.attempt}`, ...event });
  };
  const result = (status: RepairResult["status"], reason?: string): RepairResult => ({
    ok: status === "verified",
    status,
    errors,
    filesChanged: [...filesChanged],
    attempts,
    ...(reason ? { reason } : {}),
  });

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return result("unverified", "Cancelled");
    await emit({ phase: "verify", attempt, status: "running" });
    const check = () => verify(sandbox, dir, secrets);
    const outcome = await (step ? step(`${prefix}:verify:${attempt}`, check) : check());
    errors = outcome.errors;

    if (outcome.status === "passed") {
      await emit({ phase: "verify", attempt, status: "done" });
      return result("verified");
    }
    if (outcome.status === "unverified") {
      await emit({ phase: "verify", attempt, status: "error", reason: outcome.reason });
      return result("unverified", outcome.reason);
    }
    const owned = filterErrors ? filterErrors(errors) : errors;
    if (owned.length === 0) {
      await emit({ phase: "verify", attempt, status: "done", errors, reason: "Only filtered-out errors remain" });
      return result("scoped-ok", "Only filtered-out errors remain");
    }
    await emit({ phase: "verify", attempt, status: "error", errors });
    if (attempts >= cap) return result("failed", `Build still fails after ${attempts} repair attempt(s)`);
    if (signal?.aborted) return result("unverified", "Cancelled");

    attempts += 1;
    await emit({ phase: "repair", attempt, status: "running" });
    let changed: string[];
    try {
      changed = await repair({
        sandbox, dir, model, name: `${prefix}:repair:${attempt}`, errors: owned, paths: outcome.paths, signal,
      });
    } catch (error) {
      console.error("[sandbox-repair] repair failed", projectId, error);
      const reason = redact(`Repair could not run (${error instanceof Error ? error.message : "unknown error"})`, secrets);
      await emit({ phase: "repair", attempt, status: "error", reason });
      return result("failed", reason);
    }
    changed.forEach((path) => filesChanged.add(path));
    if (signal?.aborted) {
      await emit({ phase: "repair", attempt, status: "error", filesChanged: changed, reason: "Cancelled" });
      return result("unverified", "Cancelled");
    }
    if (changed.length === 0) {
      await emit({ phase: "repair", attempt, status: "error", reason: "Repair made no changes" });
      return result("failed", "Repair made no changes");
    }
    await emit({ phase: "repair", attempt, status: "done", filesChanged: changed });
  }
};
