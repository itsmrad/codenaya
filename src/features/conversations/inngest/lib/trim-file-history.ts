import type { TextMessage, ToolCallMessage, ToolResultMessage, ToolMessage } from "@inngest/agent-kit";

import { FILE_HISTORY_PLACEHOLDER } from "../constants";

const omitted = (detail: string) => FILE_HISTORY_PLACEHOLDER.replace("{detail}", detail);

export type HistoryMessage = TextMessage | ToolCallMessage | ToolResultMessage;

// Four characters per token is deliberately only an estimate (#298).
/** Trimming starts once the model's view of the history is over this. */
export const FILE_HISTORY_THRESHOLD = 40_000 * 4;
/**
 * A cut must save at least this much. Every cut rewrites the history after it,
 * which the provider's prompt cache then misses, so cuts are rare and deep.
 */
export const FILE_HISTORY_MIN_CUT = 20_000 * 4;
/** Turns always kept whole. */
export const RECENT_TURNS = 6;
/** Turns one cut trims at least, so even turns too large for the budget cut only now and then. */
export const MIN_CUT_TURNS = 6;

/** FNV-1a: a short, stable tag for a file body, so stubs differ when the content did. */
const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};
const lineCount = (text: string) => text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
const stub = (path: string, content: string) => `${path}, ${lineCount(content)} lines, hash ${hash(content)}`;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only known file tools may have their payloads cleared; MCP tools are opaque. */
function fileReference(file: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "fileId", "id", "name"]) {
    if (typeof file[key] === "string") return file[key];
  }
}

function trimWrite(tool: ToolMessage): ToolMessage {
  if (!record(tool.input)) return tool;
  if (!["updateFile", "createFiles", "writeFiles", "editFile"].includes(tool.name)) return tool;
  const clear = (file: unknown): unknown => {
    if (!record(file) || typeof file.content !== "string") return file;
    const path = fileReference(file);
    if (!path) return file;
    return { ...file, content: omitted(`write supplied for ${stub(path, file.content)}`) };
  };
  if (tool.name === "editFile" && fileReference(tool.input) && Array.isArray(tool.input.edits)) {
    const placeholder = omitted(`edits to ${fileReference(tool.input)}, hash ${hash(JSON.stringify(tool.input.edits))}`);
    return { ...tool, input: { ...tool.input, edits: [{ oldText: placeholder, newText: placeholder }] } };
  }
  const input = ["createFiles", "writeFiles"].includes(tool.name) && Array.isArray(tool.input.files)
    ? { ...tool.input, files: tool.input.files.map(clear) }
    : clear(tool.input) as Record<string, unknown>;
  return { ...tool, input };
}

function trimRead(content: unknown, tool: ToolMessage): unknown {
  if (!record(tool.input)) return content;
  const paths = tool.input.paths ?? tool.input.fileIds ??
    (Array.isArray(tool.input.ranges) ? tool.input.ranges.filter(record).map((range) => range.path) : undefined);
  if (!Array.isArray(paths)) return content;
  // AgentKit wraps handler output in {data}; keep missing-file/error metadata.
  if (!record(content) || !("data" in content)) return content;
  const clearFiles = (files: unknown[]) => files.map((file) => {
    if (!record(file) || typeof file.content !== "string") return file;
    const path = fileReference(file);
    return path ? { ...file, content: omitted(`content of ${stub(path, file.content)}`) } : file;
  });
  const data = content.data;
  let parsed: unknown = data;
  if (typeof data === "string") {
    const lines = data.split("\n");
    const errors = lines.filter((line) => /^Error\b/i.test(line));
    if (lines.every((line) => !line.trim() || /^Error\b/i.test(line))) return content;
    const fallback = { ...content, data: [omitted(`content of ${paths.join(", ")}, hash ${hash(data)}`), ...errors].join("\n") };
    try { parsed = JSON.parse(data); } catch { return fallback; }
    if (!Array.isArray(parsed) && !(record(parsed) && Array.isArray(parsed.files))) return fallback;
  }
  const trimmed = Array.isArray(parsed) ? clearFiles(parsed) :
    record(parsed) && Array.isArray(parsed.files) ? { ...parsed, files: clearFiles(parsed.files) } : parsed;
  return { ...content, data: typeof data === "string" ? JSON.stringify(trimmed) : trimmed };
}

type Trimmed = { json: string; call?: ToolMessage; message: HistoryMessage; size: number };
/** Per message object: a run asks for the same history again every turn. Keyed on its JSON too, so a mutated message is trimmed afresh. */
const trimCache = new WeakMap<HistoryMessage, Trimmed>();

/** A message as it reads once trimmed; `call` (the latest earlier call with its id) gives a result its input. */
function trimMessage(message: HistoryMessage, json: string, call: ToolMessage | undefined): Trimmed {
  const hit = trimCache.get(message);
  if (hit && hit.json === json && hit.call === call) return hit;
  const trimmed: HistoryMessage =
    message.type === "tool_call" ? { ...message, tools: message.tools.map(trimWrite) } :
    message.type === "tool_result" && call ? {
      ...message,
      tool: message.tool.input ? trimWrite(message.tool) : message.tool,
      content: message.tool.name === "readFiles" ? trimRead(message.content, call) : message.content,
    } : message;
  const entry = { json, call, message: trimmed, size: trimmed === message ? json.length : JSON.stringify(trimmed).length };
  trimCache.set(message, entry);
  return entry;
}

/**
 * A model-only view: never mutate persisted results or executable tool inputs.
 * Text (including earlier conversation turns), ids and message order stay intact.
 *
 * Cache-stable: every message before the cutoff is replaced by its trimmed
 * form, which depends only on that message, and the cutoff is found by
 * replaying the history one message at a time. So a longer history keeps the
 * cutoff of its prefix until it again goes over FILE_HISTORY_THRESHOLD, and
 * then moves it as far as RECENT_TURNS allows, by at least MIN_CUT_TURNS
 * turns and FILE_HISTORY_MIN_CUT. Between cuts, each request's history is the previous
 * one plus new turns, byte for byte.
 */
export function trimFileHistory(history: HistoryMessage[]): HistoryMessage[] {
  const json = history.map((message) => JSON.stringify(message));
  // Sizes of history[0, i) as is.
  const rawTo = [0];
  json.forEach((text, i) => rawTo.push(rawTo[i] + text.length));
  if (rawTo[history.length] <= FILE_HISTORY_THRESHOLD) return history;
  const starts = history.flatMap((message, i) =>
    message.type === "tool_call" ||
    (message.type === "text" && message.role === "assistant" && history[i + 1]?.type !== "tool_call")
      ? [i] : [],
  );
  const calls = new Map<string, ToolMessage>();
  const callOf = history.map((message) => {
    if (message.type === "tool_call") message.tools.forEach((tool) => calls.set(tool.id, tool));
    return message.type === "tool_result" ? calls.get(message.tool.id) : undefined;
  });
  // Trimmed only as far as a cut is weighed: the newest turns never are.
  const trimmed: HistoryMessage[] = [];
  const smallTo = [0];
  const trimmedBefore = (end: number) => {
    for (let i = smallTo.length - 1; i < end; i++) {
      const entry = trimMessage(history[i], json[i], callOf[i]);
      trimmed.push(entry.message);
      smallTo.push(smallTo[i] + entry.size);
    }
    return smallTo[end];
  };
  const view = (cutoff: number, end: number) => trimmedBefore(cutoff) + rawTo[end] - rawTo[cutoff];

  let cutoff = 0;
  let cutTurns = 0; // Turns before the cutoff.
  let turns = 0; // Turn starts in history[0, end).
  for (let end = 1; end <= history.length; end++) {
    if (starts[turns] === end - 1) turns += 1;
    const deepTurns = turns - RECENT_TURNS;
    if (deepTurns - cutTurns < MIN_CUT_TURNS || view(cutoff, end) <= FILE_HISTORY_THRESHOLD) continue;
    const deepest = starts[deepTurns];
    if (view(cutoff, end) - view(deepest, end) >= FILE_HISTORY_MIN_CUT) {
      cutoff = deepest;
      cutTurns = deepTurns;
    }
  }
  return cutoff === 0 ? history : history.map((message, i) => (i < cutoff ? trimmed[i] : message));
}
