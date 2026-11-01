import type { TextMessage, ToolCallMessage, ToolResultMessage, ToolMessage } from "@inngest/agent-kit";

import { FILE_HISTORY_PLACEHOLDER } from "../constants";

const omitted = (detail: string) => FILE_HISTORY_PLACEHOLDER.replace("{detail}", detail);

export type HistoryMessage = TextMessage | ToolCallMessage | ToolResultMessage;

// Four characters per token is deliberately only an estimate (#298).
export const FILE_HISTORY_THRESHOLD = 60_000 * 4;
const RECENT_TURNS = 6;
const CHUNK_TURNS = 6;

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
    const lines = file.content === "" ? 0 : file.content.split("\n").length - Number(file.content.endsWith("\n"));
    return { ...file, content: omitted(`${lines} lines supplied for ${path}`) };
  };
  if (tool.name === "editFile" && fileReference(tool.input) && Array.isArray(tool.input.edits)) {
    const placeholder = omitted(`edits to ${fileReference(tool.input)}`);
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
    return path ? { ...file, content: omitted(`content of ${path}`) } : file;
  });
  const data = content.data;
  let parsed: unknown = data;
  if (typeof data === "string") {
    const lines = data.split("\n");
    const errors = lines.filter((line) => /^Error\b/i.test(line));
    if (lines.every((line) => !line.trim() || /^Error\b/i.test(line))) return content;
    const fallback = { ...content, data: [omitted(`content of ${paths.join(", ")}`), ...errors].join("\n") };
    try { parsed = JSON.parse(data); } catch { return fallback; }
    if (!Array.isArray(parsed) && !(record(parsed) && Array.isArray(parsed.files))) return fallback;
  }
  const trimmed = Array.isArray(parsed) ? clearFiles(parsed) :
    record(parsed) && Array.isArray(parsed.files) ? { ...parsed, files: clearFiles(parsed.files) } : parsed;
  return { ...content, data: typeof data === "string" ? JSON.stringify(trimmed) : trimmed };
}

/**
 * A model-only view: never mutate persisted results or executable tool inputs.
 * Use raw history on every replay, so the threshold and chunk boundary are stable.
 * Text (including earlier conversation turns), ids and message order stay intact.
 */
export function trimFileHistory(history: HistoryMessage[]): HistoryMessage[] {
  if (JSON.stringify(history).length <= FILE_HISTORY_THRESHOLD) return history;
  const starts = history.flatMap((message, i) =>
    message.type === "tool_call" ||
    (message.type === "text" && message.role === "assistant" && history[i + 1]?.type !== "tool_call")
      ? [i] : [],
  );
  const oldTurns = Math.floor((starts.length - RECENT_TURNS) / CHUNK_TURNS) * CHUNK_TURNS;
  if (oldTurns <= 0) return history;
  const cutoff = starts[oldTurns];
  const oldCalls = new Map<string, ToolMessage>();
  return history.map((message, i) => {
    if (message.type === "tool_call" && i < cutoff) {
      for (const tool of message.tools) oldCalls.set(tool.id, tool);
      return { ...message, tools: message.tools.map(trimWrite) };
    }
    if (message.type === "tool_result" && i < cutoff && oldCalls.has(message.tool.id)) {
      return {
        ...message,
        tool: message.tool.input ? trimWrite(message.tool) : message.tool,
        content: message.tool.name === "readFiles" ? trimRead(message.content, oldCalls.get(message.tool.id)!) : message.content,
      };
    }
    return message;
  });
}
