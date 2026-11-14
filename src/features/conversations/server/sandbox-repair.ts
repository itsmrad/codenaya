import { type Tool, createAgent, createNetwork } from "@inngest/agent-kit";
import type { Sandbox } from "e2b";

import {
  BUILD_CHECK_UNFINISHED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  buildPathIndex,
  describeToolCall,
  toolResultError,
} from "@/features/conversations/agent-steps";
import { checkProjectBuild, isSafeProjectPath, redact } from "@/features/conversations/inngest/tools/check-build";
import { createDeleteFilesTool } from "@/features/conversations/inngest/tools/delete-files";
import { createEditFileTool } from "@/features/conversations/inngest/tools/edit-file";
import { createReadFilesTool } from "@/features/conversations/inngest/tools/read-files";
import { createWriteFilesTool } from "@/features/conversations/inngest/tools/write-files";
import { type ProjectFile, WORK_DIR } from "@/features/sandbox-preview/server/project-sandbox";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * Build check and model repair for one caller-owned sandbox (SWARM workers
 * and the integration sandbox). The single-agent chat run keeps its own
 * checkBuild tool and build gate; this does not replace them.
 *
 * Each verify reads the text files under `dir` (up to MAX_SNAPSHOT_FILES)
 * for the static checks, then copies `dir` into a directory of its own and
 * runs a fresh `npm install`, type check and build there
 * (`checkProjectBuild` with `sandbox`); uploads and large files are built
 * from that copy. The sandbox is never looked up, created or killed here. A pass proves install, type check and production build
 * only: runtime errors in the preview are not checked.
 *
 * Repairs write through the agent's own Convex file tools, so they reach the
 * project the user sees (and every later integration); the files they wrote
 * are then copied from Convex into the sandbox before it is checked again.
 *
 * Example, in an Inngest function body (not inside `step.run`, since the
 * repair agent's model calls and the file tools are steps of their own; the
 * file tools write nothing outside an Inngest function):
 *
 *   const result = await verifyAndFix({
 *     sandbox, projectId, internalKey, runId: event.data.runId, agentTaskId: task.id,
 *     allowedPaths: (path) => task.paths.includes(path),
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
/** Larger files skip the static checks; the in-sandbox copy still builds them. */
const MAX_TEXT_BYTES = 1_000_000;
const MAX_SNAPSHOT_FILES = 2_000;
const SHORT_CALL_MS = 10_000;
/** Never read into a check or copied into the sandbox, like the preview's `.env` on the warm path. */
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
  projectId: Id<"projects">;
  /** For the Convex file tools the repair agent writes with. */
  internalKey: string;
  runId: string;
  /** Tells parallel workers' step and event ids apart. */
  agentTaskId?: string;
  /** The repair agent's model, built by the caller (`buildAgentKitModel`). */
  model: Model;
  /** Repairs, 1 to MAX_REPAIR_ATTEMPTS; anything else is clamped, and NaN means the maximum. */
  maxAttempts?: number;
  /** Keep the errors this worker owns; what it drops can only yield `scoped-ok`. */
  filterErrors?: (errors: BuildError[]) => BuildError[];
  /** The paths the repair may write, edit or delete; a call naming any other is refused whole. */
  allowedPaths?: (path: string) => boolean;
  /**
   * Checked before each check and repair, by the repair agent's router and by
   * its write tools. An in-flight check or model request is not interrupted:
   * cancelling waits for it, bounded by the check's 240 s budget or the
   * model's request time. The sandbox is never killed to abort. It is per
   * invocation: an Inngest replay starts with the signal it is given then.
   */
  signal?: AbortSignal;
  /** Redacted from every error, event and result. */
  secrets?: string[];
  onEvent?: (event: RepairEvent) => void | Promise<void>;
  /**
   * Runs each verify and each copy into the sandbox as a durable step,
   * `<runId>:<agentTaskId>:verify:<n>` and `...:sync:<n>`, e.g.
   * `(id, fn) => step.run(id, fn)`. Results are plain JSON.
   */
  step?: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
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
          return null; // Binary: built from the in-sandbox copy.
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
  const text = await checkProjectBuild({ files: snap.files, paths: snap.paths, sandbox, sourceDir: dir, secrets });
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
  "You fix build errors in a Vite + TypeScript project. Read the files you need with readFiles, then fix them " +
  "with editFile (or writeFiles for a whole file). Make the smallest change that fixes the listed errors and " +
  "change nothing else. When done, reply with one line saying what you changed.";

/** The paths a successful file tool call changed: all it named, except a partial writeFiles' failures. */
const succeededPaths = (tool: string, targets: string[], result: unknown) => {
  if (tool !== "writeFiles" || typeof result !== "string") return targets;
  // "Wrote 2 file(s). Created: a.ts. Updated: b.ts, c.ts. Failed: d.ts (...)."
  const listed = [...result.matchAll(/(?:Created|Updated): (.+?)\.(?=\s|$)/g)].flatMap(([, list]) => list.split(", "));
  return targets.filter((path) => listed.includes(path));
};

/**
 * The repair agent's tools: the chat agent's Convex file tools, with every
 * step id under this repair's `name`. The tools' own ids are fixed
 * ("write-files"), and Inngest numbers repeats in the order it finds them,
 * which differs between parallel workers' replays; per-worker ids keep one
 * worker from replaying another's memoized write. (The tools use only
 * `step.run`.) Writes are also checked against `allowedPaths`, and the paths
 * they changed are pushed to `written`, on replays too.
 */
export const repairTools = ({
  projectId, internalKey, name, signal, allowedPaths, written,
}: {
  projectId: Id<"projects">;
  internalKey: string;
  name: string;
  signal?: AbortSignal;
  allowedPaths?: (path: string) => boolean;
  written: string[];
}): Tool.Any[] => {
  const scoped = (tool: Tool.Any): Tool.Any => ({
    ...tool,
    handler: (input, opts) => {
      const { step } = opts;
      if (!step) return tool.handler(input, opts);
      const run = step.run as (id: string, ...rest: unknown[]) => unknown;
      const prefixed = (id: string, ...rest: unknown[]) => run(`${name}:${id}`, ...rest);
      return tool.handler(input, { ...opts, step: { ...step, run: prefixed as typeof step.run } });
    },
  });
  const guarded = (tool: Tool.Any): Tool.Any => {
    const inner = scoped(tool);
    return {
      ...inner,
      handler: async (input, opts) => {
        if (signal?.aborted) return "Error: Cancelled";
        const targets = describeToolCall({ name: tool.name, input: input as Record<string, unknown> }, () => undefined);
        // By id (`fileIds`), a call could reach files no check below sees.
        if (targets.length === 0) return "Error: Name the files to change by path.";
        const outside = allowedPaths && targets.find((path) => !allowedPaths(path));
        if (outside) return `Error: ${outside} is outside this task's files`;
        const result = await inner.handler(input, opts);
        if (toolResultError({ data: result }) === undefined) written.push(...succeededPaths(tool.name, targets, result));
        return result;
      },
    };
  };
  return [
    scoped(createReadFilesTool({ projectId, internalKey })),
    guarded(createWriteFilesTool({ projectId, internalKey })),
    guarded(createEditFileTool({ projectId, internalKey })),
    guarded(createDeleteFilesTool({ projectId, internalKey })),
  ];
};

/**
 * Runs the repair agent once on the agent's Convex file tools; returns the
 * paths its successful writes named. Write calls naming a path outside
 * `allowedPaths` are refused whole, as SWARM's own guard does.
 */
const repair = async ({
  projectId, internalKey, model, name, errors, paths, signal, allowedPaths,
}: {
  projectId: Id<"projects">;
  internalKey: string;
  model: Model;
  name: string;
  errors: BuildError[];
  paths: string[];
  signal?: AbortSignal;
  allowedPaths?: (path: string) => boolean;
}) => {
  const written: string[] = [];
  const agent = createAgent({
    name,
    system: REPAIR_SYSTEM,
    model,
    tools: repairTools({ projectId, internalKey, name, signal, allowedPaths, written }),
  });
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
  return [...new Set(written)];
};

/**
 * Copies `paths` from the project in Convex into the sandbox: written files
 * are overwritten, deleted ones removed. Returns the paths whose sandbox copy
 * changed. Files with no text (uploads) are left as they are.
 */
const mirror = async (
  sandbox: Sandbox,
  dir: string,
  { projectId, internalKey }: { projectId: Id<"projects">; internalKey: string },
  paths: string[],
) => {
  const rows = await convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
  const pathOf = buildPathIndex(rows);
  const byPath = new Map(rows.map((row) => [pathOf(row._id), row]));
  const opts = { requestTimeoutMs: SHORT_CALL_MS };
  const changed: string[] = [];
  for (const path of paths) {
    if (!readable(path)) continue;
    const row = byPath.get(path);
    const target = `${dir}/${path}`;
    if (!row) {
      if (await sandbox.files.exists(target, opts)) {
        await sandbox.files.remove(target, opts);
        changed.push(path);
      }
    } else if (row.type === "file" && typeof row.content === "string") {
      if ((await sandbox.files.read(target, opts).catch(() => undefined)) !== row.content) {
        await sandbox.files.write(target, row.content, opts);
        changed.push(path);
      }
    }
  }
  return changed;
};

/**
 * Checks the project in `sandbox` and, while it fails on code, has the model
 * repair it and checks again, up to `maxAttempts` repairs. Never throws.
 */
export const verifyAndFix = async ({
  sandbox,
  dir = WORK_DIR,
  projectId,
  internalKey,
  runId,
  agentTaskId = "main",
  model,
  maxAttempts = MAX_REPAIR_ATTEMPTS,
  filterErrors,
  allowedPaths,
  signal,
  secrets = [],
  onEvent,
  step,
}: VerifyAndFixOptions): Promise<RepairResult> => {
  const prefix = `${runId}:${agentTaskId}`;
  const cap = Number.isFinite(maxAttempts)
    ? Math.min(Math.max(Math.trunc(maxAttempts), 1), MAX_REPAIR_ATTEMPTS)
    : MAX_REPAIR_ATTEMPTS;
  const filesChanged = new Set<string>();
  let errors: BuildError[] = [];
  let attempts = 0;

  const durable = <T>(id: string, fn: () => Promise<T>) =>
    step ? (step(`${prefix}:${id}`, fn) as Promise<T>) : fn();
  const failure = (what: string, error: unknown) =>
    redact(`${what} (${error instanceof Error ? error.message : "unknown error"})`, secrets);
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
    const outcome = await durable(`verify:${attempt}`, () => verify(sandbox, dir, secrets));
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
    let written: string[];
    try {
      written = await repair({
        projectId, internalKey, model, name: `${prefix}:repair:${attempt}`,
        errors: owned, paths: outcome.paths, signal, allowedPaths,
      });
    } catch (error) {
      console.error("[sandbox-repair] repair failed", projectId, error);
      const reason = failure("Repair could not run", error);
      await emit({ phase: "repair", attempt, status: "error", reason });
      return result("failed", reason);
    }
    let changed: string[];
    try {
      changed = written.length
        ? await durable(`sync:${attempt}`, () => mirror(sandbox, dir, { projectId, internalKey }, written))
        : [];
    } catch (error) {
      // The repair is in Convex; only this sandbox's copy is behind.
      written.forEach((path) => filesChanged.add(path));
      const reason = failure("Could not copy the repair into the sandbox", error);
      await emit({ phase: "repair", attempt, status: "error", filesChanged: written, reason });
      return result("unverified", reason);
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
