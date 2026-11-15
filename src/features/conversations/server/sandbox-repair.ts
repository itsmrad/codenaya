import { type Tool, createAgent, createNetwork } from "@inngest/agent-kit";

import {
  BUILD_CHECK_UNFINISHED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  buildPathIndex,
  describeToolCall,
  toolResultError,
} from "@/features/conversations/agent-steps";
import { decodeJsonArgs } from "@/features/conversations/inngest/lib/json-args";
import { checkProjectBuild, isSafeProjectPath, projectFramework, redact } from "@/features/conversations/inngest/tools/check-build";
import { createDeleteFilesTool } from "@/features/conversations/inngest/tools/delete-files";
import { createEditFileTool } from "@/features/conversations/inngest/tools/edit-file";
import { createReadFilesTool } from "@/features/conversations/inngest/tools/read-files";
import { createWriteFilesTool } from "@/features/conversations/inngest/tools/write-files";
import { type ProjectFile, WORK_DIR } from "@/features/sandbox-preview/server/project-sandbox";
import { exists, remove, runOrThrow } from "@/features/sandbox-preview/server/provider/helpers";
import type { Sandbox } from "@/features/sandbox-preview/server/provider/types";
import type { Framework } from "@/features/sandbox-preview/utils/framework";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * Build check and model repair for one caller-owned sandbox (SWARM workers,
 * the integration sandbox, and a chat run whose own build gate ended on a
 * failed check: `inngest/build-repair.ts`). The chat run keeps its checkBuild
 * tool and build gate; this runs only after them.
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
/** Files the errors name, shown whole in the repair prompt so it need not read them first. */
const MAX_SOURCE_FILES = 3;
const MAX_SOURCE_CHARS = 20_000;
const SHORT_CALL_MS = 10_000;
/**
 * Never read into a check or copied into the sandbox, like the preview's `.env` on the warm path.
 * Build output (Vite's dist, Next.js's .next and out, TanStack Start's .output, .tanstack, .nitro
 * and legacy .vinxi) and Next.js's generated next-env.d.ts.
 */
const SKIPPED_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "out", "next-env.d.ts", ".output", ".tanstack", ".nitro", ".vinxi",
]);
/** Written by `vite build`: a repair edit would be overwritten, so repairs may not touch it. */
const ROUTE_TREE = "src/routeTree.gen.ts";
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
type CheckOutcome = {
  status: "passed" | "failed" | "unverified";
  errors: BuildError[];
  paths: string[];
  reason?: string;
  /** On a failed check, for the repair prompt; missing on outcomes memoized before Next.js support (Vite). */
  framework?: Framework | null;
  /** On a failed check: the files the errors name, for the repair prompt. */
  sources?: ProjectFile[];
};

type Model = NonNullable<Parameters<typeof createAgent>[0]["model"]>;

export type VerifyAndFixOptions = {
  /**
   * Caller-owned and left running. A function is called only inside a verify
   * or sync, so replays of memoized steps never connect to it.
   */
  sandbox: Sandbox | (() => Promise<Sandbox>);
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
  /**
   * Escalation, e.g. a cheap `model` first and the run's own model last: once
   * `after` repairs on `model` have run, or one changed nothing or threw, the
   * remaining repairs use `fallback.model`.
   */
  fallback?: { model: Model; after: number };
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
  /** Called with each of the repair agent's model responses, e.g. to meter its usage; `onFallback` names the model. */
  onResponse?: (raw: string | undefined, onFallback: boolean) => Promise<void>;
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
  const listing = await runOrThrow(
    sandbox,
    `find . -type f ${[...SKIPPED_DIRS].map((dir) => `-not -path './${dir}/*'`).join(" ")} -printf '%s %P\\n'`,
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
        const bytes = await sandbox.readFile(`${dir}/${path}`, "bytes", { requestTimeoutMs: SHORT_CALL_MS });
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
// next build: "./src/app/page.tsx:12:3" alone, then the message on the next line.
const LOCATION_ONLY = /^(?:\.\/)?([\w@./-]+\.\w+)(?::(\d+):\d+)?$/;
const NEXT_MESSAGE = /^(?:Type error|Module not found|Syntax error|Error): /;

/** checkBuild's failure text as structured errors; the whole body when no line names a file. */
export const parseBuildErrors = (text: string): BuildError[] => {
  const [head, ...body] = text.split("\n");
  if (head.startsWith(STATIC_CHECKS_FAILED)) {
    const listed = body.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    return (listed.length ? listed : [head]).map((message) => ({ message, kind: "static" }));
  }
  const install = head.startsWith("Error: npm install failed");
  const located = body.flatMap((line, index): BuildError[] => {
    const alone = LOCATION_ONLY.exec(line);
    const next = body[index + 1] ?? "";
    if (alone && NEXT_MESSAGE.test(next)) {
      return [{
        file: alone[1],
        ...(alone[2] ? { line: Number(alone[2]) } : {}),
        message: next,
        kind: install ? "install" : next.startsWith("Type error") ? "type" : "build",
      }];
    }
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

const verify = async (connect: () => Promise<Sandbox>, dir: string, secrets: string[]): Promise<CheckOutcome> => {
  let sandbox;
  let snap;
  try {
    sandbox = await connect();
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
  const errors = parseBuildErrors(text);
  return {
    status: "failed",
    errors,
    paths,
    framework: projectFramework(snap.files, snap.paths),
    sources: errorSources(snap.files, errors, secrets),
  };
};

/** The first few files the errors name: small ones holding none of the secrets. */
const errorSources = (files: ProjectFile[], errors: BuildError[], secrets: string[]) => {
  const named = new Set(errors.flatMap(({ file }) => (file ? [file.replace(/^\.\//, "")] : [])));
  return files
    .filter(({ path, content }) =>
      named.has(path) && content.length <= MAX_SOURCE_CHARS && !secrets.some((secret) => secret && content.includes(secret)))
    .slice(0, MAX_SOURCE_FILES);
};

const repairSystem = (framework?: Framework | null) =>
  `You fix build errors in a ${framework === "next" ? "Next.js (App Router)" : framework === "tanstack-start" ? "TanStack Start (Vite)" : "Vite"} + TypeScript project. ` +
  "Read the files you need with readFiles, then fix them " +
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
  ].map(decodeJsonArgs);
};

/**
 * Runs the repair agent once on the agent's Convex file tools; returns the
 * paths its successful writes named. Write calls naming a path outside
 * `allowedPaths` are refused whole, as SWARM's own guard does.
 */
const repair = async ({
  projectId, internalKey, model, name, errors, paths, framework, sources = [], signal, allowedPaths, onResponse, written,
}: {
  projectId: Id<"projects">;
  internalKey: string;
  model: Model;
  name: string;
  errors: BuildError[];
  paths: string[];
  framework?: Framework | null;
  sources?: ProjectFile[];
  signal?: AbortSignal;
  allowedPaths?: (path: string) => boolean;
  onResponse?: (raw: string | undefined) => Promise<void>;
  /** The caller's: holds what was written even when the repair throws. */
  written: string[];
}) => {
  const agent = createAgent({
    name,
    system: repairSystem(framework),
    model,
    tools: repairTools({ projectId, internalKey, name, signal, allowedPaths, written }),
    lifecycle: {
      onResponse: async ({ result }) => {
        await onResponse?.(result.raw);
        return result;
      },
    },
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
  // Only the errors and the files they name: never the chat, so a cheap model can do it.
  const shown = sources.map(({ path, content }) => `--- ${path} ---\n${content}`);
  await network.run(
    `The build check failed with:\n${listed.join("\n")}\n\nProject files:\n${paths.slice(0, 300).join("\n")}` +
      (shown.length ? `\n\nCurrent content of files the errors name (no need to read these again):\n${shown.join("\n")}` : ""),
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
      if (await exists(sandbox, target, opts)) {
        await remove(sandbox, target, opts);
        changed.push(path);
      }
    } else if (row.type === "file" && typeof row.content === "string") {
      if ((await sandbox.readFile(target, "text", opts).catch(() => undefined)) !== row.content) {
        await sandbox.writeFiles([{ path: target, data: row.content }], opts);
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
  fallback,
  maxAttempts = MAX_REPAIR_ATTEMPTS,
  filterErrors,
  allowedPaths,
  signal,
  secrets = [],
  onEvent,
  onResponse,
  step,
}: VerifyAndFixOptions): Promise<RepairResult> => {
  const connect = typeof sandbox === "function" ? sandbox : async () => sandbox;
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

  let escalated = false;
  // Kept for the next pass when a repair on `model` changed nothing: the
  // sandbox is as checked, so the fallback gets the same errors unchecked.
  let checked: CheckOutcome | undefined;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return result("unverified", "Cancelled");
    let outcome = checked;
    checked = undefined;
    if (!outcome) {
      await emit({ phase: "verify", attempt, status: "running" });
      outcome = await durable(`verify:${attempt}`, () => verify(connect, dir, secrets));
      errors = outcome.errors;

      if (outcome.status === "passed") {
        await emit({ phase: "verify", attempt, status: "done" });
        return result("verified");
      }
      if (outcome.status === "unverified") {
        await emit({ phase: "verify", attempt, status: "error", reason: outcome.reason });
        return result("unverified", outcome.reason);
      }
      if ((filterErrors ? filterErrors(errors) : errors).length === 0) {
        await emit({ phase: "verify", attempt, status: "done", errors, reason: "Only filtered-out errors remain" });
        return result("scoped-ok", "Only filtered-out errors remain");
      }
      await emit({ phase: "verify", attempt, status: "error", errors });
    }
    const owned = filterErrors ? filterErrors(errors) : errors;
    if (attempts >= cap) return result("failed", `Build still fails after ${attempts} repair attempt(s)`);
    if (signal?.aborted) return result("unverified", "Cancelled");

    const escalation = fallback && (escalated || attempts >= fallback.after) ? fallback : undefined;
    const onFallback = escalation !== undefined;
    // Until it has had its turn, the fallback takes over from a failed repair.
    const canEscalate = fallback !== undefined && !onFallback;
    attempts += 1;
    await emit({ phase: "repair", attempt, status: "running" });
    const wrote: string[] = [];
    let written: string[];
    // Set when a repair that could escalate threw: the fallback takes over.
    let crashed: string | undefined;
    try {
      written = await repair({
        projectId, internalKey, model: escalation?.model ?? model, name: `${prefix}:repair:${attempt}`,
        errors: owned, paths: outcome.paths, framework: outcome.framework, sources: outcome.sources,
        signal, allowedPaths: (path) => path !== ROUTE_TREE && (allowedPaths?.(path) ?? true), onResponse: onResponse && ((raw) => onResponse(raw, onFallback)), written: wrote,
      });
    } catch (error) {
      console.error("[sandbox-repair] repair failed", projectId, error);
      const reason = failure("Repair could not run", error);
      if (!canEscalate) {
        await emit({ phase: "repair", attempt, status: "error", reason });
        return result("failed", reason);
      }
      // What it wrote before the error is in Convex: copied into the sandbox below.
      written = [...new Set(wrote)];
      crashed = reason;
    }
    let changed: string[];
    try {
      changed = written.length
        ? await durable(`sync:${attempt}`, async () => mirror(await connect(), dir, { projectId, internalKey }, written))
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
    if (crashed) {
      await emit({ phase: "repair", attempt, status: "error", reason: crashed, ...(changed.length ? { filesChanged: changed } : {}) });
      escalated = true;
      // Checked again only when its writes changed the sandbox.
      if (changed.length === 0) checked = outcome;
      continue;
    }
    if (changed.length === 0) {
      await emit({ phase: "repair", attempt, status: "error", reason: "Repair made no changes" });
      if (canEscalate) {
        escalated = true;
        checked = outcome;
        continue;
      }
      return result("failed", "Repair made no changes");
    }
    await emit({ phase: "repair", attempt, status: "done", filesChanged: changed });
  }
};
