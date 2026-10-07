import type { Infer } from "convex/values";

import type { messageStepValidator } from "../../../convex/schema";

/** One recorded row of an agent run (see `messageStepValidator`). */
export type AgentStep = Infer<typeof messageStepValidator>;

/** The slice of an AgentKit tool call this module reads. */
export interface ToolCallInput {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The fields of a project file row needed to build its path. */
export interface PathIndexFile {
  _id: string;
  name: string;
  parentId?: string;
}

/** Maps file ids to slash-joined project paths (`src/app/page.tsx`). */
export const buildPathIndex = (files: PathIndexFile[]) => {
  const byId = new Map(files.map((file) => [file._id, file]));
  const paths = new Map<string, string>();
  const pathOf = (id: string, depth = 0): string | undefined => {
    const cached = paths.get(id);
    if (cached) return cached;
    const file = byId.get(id);
    // Depth guard: a corrupt parent cycle must not hang the caller.
    if (!file || depth > 64) return undefined;
    const parent = file.parentId ? pathOf(file.parentId, depth + 1) : undefined;
    const path = parent ? `${parent}/${file.name}` : file.name;
    paths.set(id, path);
    return path;
  };
  return (id: string) => pathOf(id);
};

const MAX_TARGETS = 20;
const MAX_TEXT = 2000;
const MAX_ERROR = 200;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const str = (value: unknown) => (typeof value === "string" ? value : "");

const joinPath = (parent: string | undefined, name: string) =>
  parent ? `${parent}/${name}` : name;

const urlLabel = (raw: string) => {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return raw;
  }
};

/**
 * Human-readable targets for a tool call: file paths, URLs, env keys or
 * skill names.
 *
 * File ids are resolved through `pathOf`; ids that don't resolve are dropped,
 * so a row never shows an internal id. Env var values are never read.
 */
export const describeToolCall = (
  call: Pick<ToolCallInput, "name" | "input">,
  pathOf: (fileId: string) => string | undefined,
): string[] => {
  const { name, input } = call;
  const paths = (ids: string[]) =>
    ids.map(pathOf).filter((path): path is string => Boolean(path));

  let targets: string[];
  switch (name) {
    case "readFiles":
    case "deleteFiles":
      targets = paths(strings(input.fileIds));
      break;
    case "updateFile":
      targets = paths([str(input.fileId)]);
      break;
    case "renameFile": {
      const from = pathOf(str(input.fileId));
      targets = from ? [from, str(input.newName)] : [];
      break;
    }
    case "createFiles": {
      const parent = pathOf(str(input.parentId));
      const files = Array.isArray(input.files) ? input.files : [];
      targets = files
        .map((file) => str((file as Record<string, unknown>)?.name))
        .filter(Boolean)
        .map((fileName) => joinPath(parent, fileName));
      break;
    }
    case "createFolder":
      targets = str(input.name)
        ? [joinPath(pathOf(str(input.parentId)), str(input.name))]
        : [];
      break;
    case "scrapeUrls":
      targets = strings(input.urls).map(urlLabel);
      break;
    case "setEnvVar":
      targets = str(input.key) ? [str(input.key)] : [];
      break;
    case "loadSkill":
      targets = str(input.name) ? [str(input.name)] : [];
      break;
    default:
      // MCP tools are namespaced `provider__tool`.
      targets = name.includes("__") ? [name.slice(name.indexOf("__") + 2)] : [];
  }
  return targets.slice(0, MAX_TARGETS);
};

/**
 * The error message of an AgentKit tool result, or undefined on success.
 * Tools here report failures by returning an "Error..." string; AgentKit wraps
 * thrown errors as `{ error }`.
 */
export const toolResultError = (content: unknown): string | undefined => {
  if (!content || typeof content !== "object") return undefined;
  const { data, error } = content as { data?: unknown; error?: unknown };
  let message: string | undefined;
  if (error) {
    message =
      typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  } else if (typeof data === "string" && /^error\b/i.test(data.trim())) {
    message = data.trim();
  }
  return message ? sanitizeAgentText(message).slice(0, MAX_ERROR) : undefined;
};

/** Cap for interim "thinking" text recorded alongside tool calls. */
export const clampStepText = (text: string) => text.trim().slice(0, MAX_TEXT);

// Raw special tokens and tool-call markup some models leak into text.
const MODEL_TOKEN = /<\|[^|>]{0,64}\|>/g;
const TOOL_MARKUP =
  /<\/?(?:[a-z]+_)?(?:function_calls?|tool_calls?|tool_call_begin|tool_call_end|think|thinking|invoke|parameter)\b[^>]*>/gi;
// Convex document ids: ~32 lowercase base32 chars mixing letters and digits.
const ID_BODY = String.raw`(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{28,34}`;
const DOC_ID = new RegExp(String.raw`\b${ID_BODY}\b`, "g");
const LABELLED_ID = new RegExp(
  String.raw`\s*\(?\bid:\s*["'\x60]?(${ID_BODY})\b["'\x60]?\)?`,
  "gi",
);

const sanitizeProse = (
  text: string,
  pathOf?: (id: string) => string | undefined,
) =>
  text
    .replace(MODEL_TOKEN, "")
    .replace(TOOL_MARKUP, "")
    // "(ID: abc…)" adds nothing for the reader once the path is shown.
    .replace(LABELLED_ID, (match, id: string) => {
      const path = pathOf?.(id);
      return path ? ` (${path})` : "";
    })
    .replace(DOC_ID, (id) => pathOf?.(id) ?? "a file");

/**
 * Strips leaked model tokens and internal document ids from text shown in the
 * chat. Ids resolve to file paths when `pathOf` knows them. Fenced code blocks
 * are left untouched.
 */
export const sanitizeAgentText = (
  text: string,
  pathOf?: (id: string) => string | undefined,
) =>
  text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, index) => (index % 2 ? part : sanitizeProse(part, pathOf)))
    .join("")
    .trim();

/** A run with no recorded progress for this long offers the user a retry. */
export const STALLED_RUN_MS = 5 * 60_000;

/** Latest sign of progress in a run: its start, or any step starting or ending. */
export const lastRunActivity = (startedAt: number, steps: AgentStep[]) =>
  Math.max(startedAt, ...steps.map((step) => step.endedAt ?? step.startedAt));
