import type { Message, Tool } from "@inngest/agent-kit";

/** The array params of the file tools, by tool. Other string params are never parsed: a real string can be valid JSON. */
const JSON_ARGS: Record<string, readonly string[]> = {
  writeFiles: ["files"],
  createFiles: ["files"],
  editFile: ["edits"],
  readFiles: ["paths", "ranges"],
  deleteFiles: ["paths"],
};

// A bigger string is left as it is and fails the tool's validation as usual.
const MAX_JSON_ARG = 2_000_000;

const decode = (value: unknown) => {
  if (typeof value !== "string" || value.length > MAX_JSON_ARG) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * Some models (Haiku 5.5) send a file tool's array arg as a JSON string. This
 * decodes it in place. A string that isn't a JSON array or object stays, and
 * fails the tool's normal validation.
 */
export const decodeToolInput = (name: string, input: unknown) => {
  if (typeof input !== "object" || input === null) return;
  const params = input as Record<string, unknown>;
  for (const key of JSON_ARGS[name] ?? []) {
    const decoded = decode(params[key]);
    if (decoded !== params[key]) params[key] = decoded;
  }
};

/**
 * Decodes a reply's tool calls before anything reads them. AgentKit records
 * these inputs (steps, history) and hands the same objects to the handlers.
 */
export const decodeToolCalls = (output: Message[]) => {
  for (const message of output) {
    if (message.type === "tool_call") for (const tool of message.tools) decodeToolInput(tool.name, tool.input);
  }
};

/** Decodes before every guard and handler wrapped inside, whoever calls it. Apply it outermost. */
export const decodeJsonArgs = (tool: Tool.Any): Tool.Any =>
  JSON_ARGS[tool.name]
    ? { ...tool, handler: (input, opts) => (decodeToolInput(tool.name, input), tool.handler(input, opts)) }
    : tool;
