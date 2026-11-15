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

/** Escapes raw control chars (newline, tab, CR...) inside string literals; whitespace between tokens stays as it is. */
const escapeControlChars = (text: string) => {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    out += inString && !escaped && ch < " " ? JSON.stringify(ch).slice(1, -1) : ch;
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = inString;
    else if (ch === '"') inString = !inString;
  }
  return out;
};

/** Parses a JSON-string arg, or throws when it isn't a JSON array or object. */
const parseArg = (text: string): object => {
  if (text.length > MAX_JSON_ARG) throw new Error(`over ${MAX_JSON_ARG} chars`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    try {
      parsed = JSON.parse(escapeControlChars(text));
    } catch {
      try {
        parsed = JSON.parse(escapeControlChars(text.replace(/([{,]\s*)"(\w+)">/g, '$1"$2":"')));
      } catch {
        throw error;
      }
    }
  }
  // Double-encoded: the parse gave the array's JSON text.
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`parsed to ${parsed === null ? "null" : typeof parsed}`);
  return parsed;
};

// Inngest replays reconstruct input objects, so dedupe by the masked warning text.
const warned = new Set<string>();

/**
 * Some models (Haiku 5.5) send a file tool's array arg as a JSON string. This
 * decodes it in place. A string that isn't a JSON array or object stays, and
 * fails the tool's normal validation.
 */
export const decodeToolInput = (name: string, input: unknown) => {
  if (typeof input !== "object" || input === null) return;
  const params = input as Record<string, unknown>;
  const failures: string[] = [];
  for (const key of JSON_ARGS[name] ?? []) {
    const value = params[key];
    if (typeof value !== "string") continue;
    try {
      params[key] = parseArg(value);
    } catch (error) {
      // The shape without the user's code: letters and digits masked, and the input snippet V8 quotes in its message cut.
      const shape = JSON.stringify(value.slice(0, 400).replace(/[\p{L}\p{N}]/gu, "x"));
      const reason = (error as Error).message.replace(/"[\s\S]*"/, "<input>");
      failures.push(`${name}.${key} (string, ${value.length} chars): ${reason}; shape ${shape}`);
    }
  }
  const warning = `[json-args] undecodable array arg ${failures.join(" | ")}`;
  if (failures.length > 0 && !warned.has(warning)) {
    if (warned.size >= 100) warned.clear();
    warned.add(warning);
    console.warn(warning);
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
