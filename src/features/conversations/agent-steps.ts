import type { Infer } from "convex/values";

import { recipeIdsIn } from "../sandbox-preview/utils/error-recipes";

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

/**
 * A project-relative path without a leading "./" or trailing "/", or undefined
 * when it is absolute or has empty, "." or ".." segments (#292).
 */
export const normalizePath = (raw: string) => {
  const path = raw.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (raw.trim().startsWith("/")) return undefined;
  const segments = path.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? undefined
    : path;
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
  const named = (raw: string[]) =>
    raw.map(normalizePath).filter((path): path is string => Boolean(path));

  let targets: string[];
  switch (name) {
    // Path inputs since #292; `fileId(s)` in calls recorded before it.
    case "readFiles":
    case "deleteFiles":
      targets = Array.isArray(input.paths) ? named(strings(input.paths)) : paths(strings(input.fileIds));
      break;
    case "updateFile":
      targets = "path" in input ? named([str(input.path)]) : paths([str(input.fileId)]);
      break;
    case "renameFile": {
      const from = "path" in input ? named([str(input.path)])[0] : pathOf(str(input.fileId));
      targets = from ? [from, str(input.newName)] : [];
      break;
    }
    case "writeFiles":
      targets = named(
        (Array.isArray(input.files) ? input.files : []).map((file) =>
          str((file as Record<string, unknown>)?.path),
        ),
      );
      break;
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
  // Writes keep every path: a run's diff and revert are built from them (#225).
  return FILE_WRITE_TOOLS.has(name) ? targets : targets.slice(0, MAX_TARGETS);
};

/** Tools whose finished calls change project files ("N files changed"). */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "writeFiles",
  "createFiles",
  "updateFile",
  "renameFile",
  "deleteFiles",
]);

/**
 * Every path a run's finished write calls named: created, edited, renamed
 * from or to, or deleted (#225). A folder path stands for everything under it.
 */
export const runWrittenPaths = (steps: AgentStep[]) => [
  ...new Set(
    steps
      .filter(
        (step) =>
          step.kind === "tool" && step.status === "done" && FILE_WRITE_TOOLS.has(step.tool ?? ""),
      )
      .flatMap(({ tool, targets = [] }) => {
        if (tool !== "renameFile" || targets.length < 2) return targets;
        // Renames record the new name only; it lands next to the old path.
        const [from, name] = targets;
        const slash = from.lastIndexOf("/");
        return [from, slash === -1 ? name : `${from.slice(0, slash)}/${name}`];
      }),
  ),
];

/**
 * The error message of an AgentKit tool result, or undefined on success.
 * Tools here report failures by returning an "Error..." string; AgentKit wraps
 * thrown errors as `{ error }`. Ids in the message resolve to paths via `pathOf`.
 */
export const toolResultError = (
  content: unknown,
  pathOf?: (id: string) => string | undefined,
): string | undefined => {
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
  return message ? sanitizeAgentText(message, pathOf).slice(0, MAX_ERROR) : undefined;
};

// First line of each passing checkBuild result; the run block shows it as the row label.
export const BUILD_VERIFIED = "Build verified";
export const STATIC_CHECKS_PASSED = "Static checks passed";
export const BUILD_NOT_CHECKED = "Build not checked";
/** Starts a checkBuild result that failed for reasons outside the project's code. */
export const BUILD_CHECK_UNFINISHED = "Error: The build check could not finish";
/** Starts a checkBuild result whose in-process static checks found problems. */
export const STATIC_CHECKS_FAILED = "Error: Static checks failed";

/**
 * The first line of a passing checkBuild result ("Build verified", "Static
 * checks passed"), which the run block shows as the row's label.
 */
export const buildCheckLabel = (content: unknown): string | undefined => {
  const data = (content as { data?: unknown } | null)?.data;
  return typeof data === "string" ? data.trim().split("\n")[0].slice(0, MAX_ERROR) || undefined : undefined;
};

/**
 * Failed checkBuild steps that a later passing check resolved. A static-check
 * failure is resolved by any passing check, as in the finish gate; an install
 * or build failure only by "Build verified". Running checks and checks that
 * could not finish don't count, and failures after the last pass stay open.
 */
export const fixedBuildErrors = (steps: AgentStep[]) => {
  let fixed = 0;
  let pendingStatic = 0;
  let pendingBuild = 0;
  for (const step of steps) {
    if (step.tool !== "checkBuild") continue;
    if (step.status === "error" && !step.error?.startsWith(BUILD_CHECK_UNFINISHED)) {
      if (step.error?.startsWith(STATIC_CHECKS_FAILED)) pendingStatic += 1;
      else pendingBuild += 1;
    } else if (step.status === "done") {
      fixed += pendingStatic;
      pendingStatic = 0;
      if (step.text === BUILD_VERIFIED) {
        fixed += pendingBuild;
        pendingBuild = 0;
      }
    }
  }
  return fixed;
};

/** The known-error recipes a tool result's hints name (#334), for the run record. */
export const toolResultRecipeIds = (content: unknown): string[] => {
  const data = (content as { data?: unknown } | null)?.data;
  return typeof data === "string" ? recipeIdsIn(data) : [];
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
// Tool errors: 'File with ID "abc…" not found.'
const WITH_ID = new RegExp(String.raw`\s+with ID ["'\x60](${ID_BODY})["'\x60]`, "gi");

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
    // An unresolved id would read 'File with ID "a file" not found': drop it.
    .replace(WITH_ID, (match, id: string) => {
      const path = pathOf?.(id);
      return path ? ` "${path}"` : "";
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

/**
 * A run with no recorded progress for this long is presumed lost (its worker
 * died or the backend dropped it) and is failed server-side, so a reload no
 * longer shows it as running.
 */
export const LOST_RUN_MS = 10 * 60_000;

/** Written in place of the reply when a lost run is failed. */
export const LOST_RUN_MESSAGE =
  "The agent stopped responding before it finished, so this run was ended. Please try again.";

/** Latest sign of progress in a run: its start, or any step starting or ending. */
export const lastRunActivity = (startedAt: number, steps: AgentStep[]) =>
  Math.max(startedAt, ...steps.map((step) => step.endedAt ?? step.startedAt));

/** A live run with no step yet gets a planning hint after this long (#478). */
export const FIRST_STEP_HINT_MS = 20_000;

/** A live run with no progress for this long is called slow, ahead of the stall. */
export const SLOW_RUN_MS = 2 * 60_000;

/**
 * A short, time-based status line for a live run that has gone quiet (#478),
 * or undefined while it is making progress. Past `STALLED_RUN_MS` the run row
 * reports the stall itself.
 */
export const runWaitHint = ({
  startedAt,
  steps,
  now,
}: {
  startedAt: number;
  steps: AgentStep[];
  now: number;
}) => {
  if (now - lastRunActivity(startedAt, steps) >= SLOW_RUN_MS) {
    return "Taking longer than usual. You can keep waiting, or stop it and try again.";
  }
  if (!steps.some((step) => step.kind === "tool") && now - startedAt >= FIRST_STEP_HINT_MS) {
    return "Planning the work. The first step can take a minute or two.";
  }
  return undefined;
};

/** Write tools whose targets aren't files with new content. */
const NO_CONTENT_WRITES: ReadonlySet<string> = new Set(["renameFile", "deleteFiles"]);

/**
 * Paths the run's finished steps wrote, newest first, each once (#478). Any
 * tool in FILE_WRITE_TOOLS counts, so a new write tool is listed with no change here.
 */
export const writtenFilePaths = (steps: AgentStep[]) => [
  ...new Set(
    steps
      .filter(
        (step) =>
          step.status === "done" &&
          FILE_WRITE_TOOLS.has(step.tool ?? "") &&
          !NO_CONTENT_WRITES.has(step.tool ?? ""),
      )
      .flatMap((step) => step.targets ?? [])
      .reverse(),
  ),
];
