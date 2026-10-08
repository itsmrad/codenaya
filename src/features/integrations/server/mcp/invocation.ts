/**
 * Identity for one *logical* MCP tool invocation.
 *
 * ## The problem this solves
 *
 * An Inngest function body is re-executed from the top once per step. A single
 * agent turn that calls one MCP tool re-runs the whole body ~7 times. Anything in
 * the tool handler that is not inside a durable step therefore happens ~7 times:
 * approval rows, audit rows, log lines.
 *
 * Wrapping those side effects in steps only helps if each step has an id that is
 * **stable across replays** and **unique per logical invocation**. Get the first
 * wrong and the step re-executes; get the second wrong and two different
 * migrations collide on one memoized result — the second would silently return
 * the first one's output without running.
 *
 * ## Why not a random id
 *
 * The obvious "invocation id" is a UUID. It cannot be used here: it would differ
 * on every replay, so every step id would differ, so nothing would ever be
 * memoized. The id has to be *derived* from replay-stable inputs.
 *
 * ## Why not just the tool name
 *
 * That is what the code did before, via `mcp-${qualifiedName}`, leaning on
 * Inngest's automatic step indexing to disambiguate repeats (`…`, `…:1`, `…:2`).
 * That works, but only while the *order and count* of invocations is byte-identical
 * on every replay, because the index is positional. It also means two unrelated
 * migrations are told apart only by their position in a sequence. Keying on the
 * arguments instead makes the identity describe the call rather than its position.
 *
 * ## The scheme
 *
 * `<qualifiedName>#<argsDigest>#<occurrence>`
 *
 * - `argsDigest` — short hash of the canonicalised arguments. Two different
 *   migrations get different ids even at the same position.
 * - `occurrence` — how many times this exact (tool, arguments) pair has already
 *   been seen in *this* execution. This is what preserves a legitimate repeat: an
 *   agent that deliberately applies the same idempotent statement twice gets
 *   occurrence 0 and 1, two distinct ids, and two real calls.
 *
 * Both components are deterministic given the same replayed inference results, so
 * the id is identical on every replay of the same run.
 */

import { createHash } from "node:crypto";

/**
 * Canonical JSON with sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so `{a,b}` and `{b,a}` would hash
 * differently despite being the same arguments. Tool arguments arrive from
 * `JSON.parse` of the model's output, whose key order is stable only because the
 * inference itself is memoized — that is a property of another layer, and relying
 * on it here would make this module's correctness depend on it. Sorting removes
 * the coupling.
 */
function canonicalize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (seen.has(value as object)) {
    // Circular arguments must not throw: that would turn a weird payload into a
    // failed migration.
    return '"[circular]"';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalize(v, seen)}`);

  return `{${entries.join(",")}}`;
}

/**
 * Short, stable digest of a tool call's arguments.
 *
 * Truncated to 16 hex characters. Collisions are not a security boundary here —
 * the digest only has to separate the handful of calls inside one agent run — and
 * a shorter value keeps step ids and log lines readable.
 */
export function digestToolArgs(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalize(args))
    .digest("hex")
    .slice(0, 16);
}

export interface McpInvocation {
  /** Replay-stable identity for this logical call. Used to build step ids. */
  invocationId: string;
  /** Digest of the arguments, for the audit row and logs. */
  argsDigest: string;
  /** 0 for the first call with these arguments in this execution. */
  occurrence: number;
}

/**
 * Assigns replay-stable identities to tool invocations within one execution.
 *
 * Must be created **per function-body execution**, not per process: the
 * occurrence counters have to restart at zero on every replay so that the nth
 * invocation gets the same id it got last time. In production this happens
 * naturally, because the MCP tools are rebuilt in the function body on each
 * replay.
 *
 * Not safe to share across concurrent runs, and deliberately not a module-level
 * singleton for that reason.
 */
export function createInvocationTracker() {
  const occurrences = new Map<string, number>();

  return {
    next(qualifiedName: string, args: Record<string, unknown>): McpInvocation {
      const argsDigest = digestToolArgs(args);
      const key = `${qualifiedName}#${argsDigest}`;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);

      return {
        invocationId: `${key}#${occurrence}`,
        argsDigest,
        occurrence,
      };
    },
  };
}

export type McpInvocationTracker = ReturnType<typeof createInvocationTracker>;

/**
 * Durable-execution primitives the MCP path needs.
 *
 * Abstracted rather than taking Inngest's `step` directly so the same handler
 * works under a different backend, and so tests can drive it without a workflow
 * engine. `run` must memoize by `id`; `sleep` must suspend durably rather than
 * holding the request open.
 */
export interface McpStepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, ms: number): Promise<void>;
}

/**
 * Scope a runner's step ids to one invocation.
 *
 * Keeps id construction in one place: callers ask for `"call"` or `"approval"`
 * and cannot accidentally produce an id that collides with another invocation's.
 */
export function scopeRunner(
  runner: McpStepRunner,
  invocationId: string,
): McpStepRunner {
  return {
    run: (id, fn) => runner.run(`mcp:${invocationId}:${id}`, fn),
    sleep: (id, ms) => runner.sleep(`mcp:${invocationId}:${id}`, ms),
  };
}
