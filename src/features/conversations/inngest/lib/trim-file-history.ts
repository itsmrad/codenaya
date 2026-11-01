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
  if (!["updateFile", "createFiles", "writeFiles", "editFile"].includes(tool.name)) return tool;
  const clear = (file: unknown): unknown => {
    if (!record(file) || typeof file.content !== "string") return file;
    const path = fileReference(file);
    if (!path) return file;
    return { ...file, content: omitted(`${file.content.split("\n").length} lines written to ${path}`) };
  };
  if (tool.name === "editFile" && fileReference(tool.input) && Array.isArray(tool.input.edits)) {
    return { ...tool, input: { ...tool.input, edits: omitted(`edits to ${fileReference(tool.input)}`) } };
  }
  const input = ["createFiles", "writeFiles"].includes(tool.name) && Array.isArray(tool.input.files)
    ? { ...tool.input, files: tool.input.files.map(clear) }
    : clear(tool.input) as Record<string, unknown>;
  return { ...tool, input };
}

function trimRead(content: unknown, tool: ToolMessage): unknown {
  if (!Array.isArray(tool.input.paths) && !Array.isArray(tool.input.fileIds)) return content;
  // AgentKit wraps handler output in {data}; failed results must remain readable.
  if (!record(content) || typeof content.data !== "string") return content;
  if (/^Error\b/i.test(content.data)) return content;
  const paths = (tool.input.paths ?? tool.input.fileIds) as unknown[];
  const fallback = { ...content, data: omitted(`content of ${paths.join(", ")}`) };
  let files: unknown;
  try { files = JSON.parse(content.data); } catch { return fallback; }
  if (!Array.isArray(files)) return fallback;
  return { ...content, data: JSON.stringify(files.map((file: unknown) => {
    if (!record(file) || typeof file.content !== "string") return file;
    const path = fileReference(file);
    return path ? { ...file, content: omitted(`content of ${path}`) } : file;
  })) };
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
  const oldCalls = new Map(history.slice(0, cutoff).flatMap((message) =>
    message.type === "tool_call" ? message.tools.map((tool) => [tool.id, tool] as const) : [],
  ));
  return history.map((message, i) => {
    if (message.type === "tool_call" && i < cutoff) {
      return { ...message, tools: message.tools.map(trimWrite) };
    }
    if (message.type === "tool_result" && oldCalls.has(message.tool.id)) {
      return {
        ...message,
        tool: message.tool.input ? trimWrite(message.tool) : message.tool,
        content: message.tool.name === "readFiles" ? trimRead(message.content, oldCalls.get(message.tool.id)!) : message.content,
      };
    }
    return message;
  });
}
