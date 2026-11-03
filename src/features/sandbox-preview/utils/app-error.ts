import { ANSI_PATTERN } from "./last-log-line";

/** An error in the user's app (not the sandbox), shown over the preview (#223). */
export interface AppError {
  kind: "build" | "runtime";
  message: string;
  stack?: string;
  file?: string;
  line?: number;
}

/** Caps what an error carries, so a huge stack can't flood the banner or the prompt. */
export const MAX_ERROR_TEXT = 2048;

// Vite, esbuild and tsc error shapes, matched per line.
const ERROR_LINE =
  /\[plugin:[^\]]+\]|\berror TS\d+:|Failed to resolve import|Transform failed|Internal server error:|Pre-transform error:/;
// "3:04:05 PM [vite] (client) Pre-transform error: " and similar log prefixes.
const LOG_PREFIX =
  /^.*?\[vite\]\s*(?:\([a-z]+\)\s*)?(?:Internal server error:|Pre-transform error:)?\s*/i;
const HMR_SUCCESS = /\[vite\].*\b(?:hmr update|page reload)\b/;
// The sandbox's project root (WORK_DIR); paths read better relative to it.
const WORK_DIR_PREFIX = /\/home\/user\/app\//g;

const FILE_PATTERNS = [
  /\bFile: (\S+?):(\d+)(?::\d+)?/, // Vite
  /(\S+\.\w+)\((\d+),\d+\)/, // tsc: src/App.tsx(3,20)
  /(\S+\.\w+):(\d+):\d+/, // esbuild / postcss: src/index.css:5:1
  /from "([^"]+)"/, // Failed to resolve import "./x" from "src/App.tsx"
];

const clean = (text: string) =>
  text.replace(ANSI_PATTERN, "").replace(WORK_DIR_PREFIX, "");

/** The first compile error in a chunk of dev-server output, or null. */
export const detectBuildError = (chunk: string): AppError | null => {
  const text = clean(chunk);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => ERROR_LINE.test(line));
  if (index === -1) return null;

  let message = lines[index].replace(LOG_PREFIX, "").trim();
  // "Transform failed with 1 error:" says nothing until the next line.
  const next = lines[index + 1]?.trim();
  if (message.endsWith(":") && next) message = `${message} ${next}`;

  for (const pattern of FILE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        kind: "build",
        message: message.slice(0, MAX_ERROR_TEXT),
        file: match[1],
        line: match[2] ? Number(match[2]) : undefined,
      };
    }
  }
  return { kind: "build", message: message.slice(0, MAX_ERROR_TEXT) };
};

const BUILD_LOG_TAIL = 8192;

/**
 * `detectBuildError` over the recent output, so an error the stream split
 * across chunks is still read. Reset it wherever the shown error is cleared.
 */
export const createBuildErrorDetector = () => {
  let tail = "";
  return {
    push: (chunk: string) => {
      tail = (tail + chunk).slice(-BUILD_LOG_TAIL);
      return detectBuildError(tail);
    },
    reset: () => {
      tail = "";
    },
  };
};

/** Vite applied an update: an earlier compile error may be gone. */
export const isHmrSuccess = (chunk: string) => HMR_SUCCESS.test(clean(chunk));

/** Same error, same banner. The line is left out: it moves as the code is edited. */
export const appErrorKey = (error: AppError) =>
  `${error.kind}\n${error.message}\n${error.file ?? ""}`;

/**
 * The error the banner shows, or null: not once dismissed, not without a
 * running preview, and not while a new project's first build is still being
 * written, when half-written files are expected to fail (#337).
 */
export const bannerError = (
  error: AppError | null,
  {
    dismissedId,
    previewReady,
    firstBuildRunning,
  }: { dismissedId: string | null; previewReady: boolean; firstBuildRunning: boolean },
) =>
  error && previewReady && !firstBuildRunning && appErrorKey(error) !== dismissedId ? error : null;

/** Fix runs sent for the error that was active last. */
export interface FixAttempts {
  errorId: string | null;
  count: number;
}

/**
 * Starts the count again when a different error becomes active. A cleared
 * error keeps its count: the IDE clears it on every edit, between fix runs, so
 * repeated failed fixes still reach "Still failing".
 */
export const trackFixAttempts = (prev: FixAttempts, activeId: string | null): FixAttempts =>
  activeId !== null && activeId !== prev.errorId ? { errorId: activeId, count: 0 } : prev;

/** Keeps the shown error when a repeat arrives, so HMR re-throws don't flicker. */
export const mergeAppError = (prev: AppError | null, next: AppError) =>
  prev && appErrorKey(prev) === appErrorKey(next) && prev.line ? prev : next;

const LOG_TAIL_LINES = 50;

/** The last lines of terminal output as plain text. */
export const logTail = (output: string, count = LOG_TAIL_LINES) =>
  output
    .slice(-16_384)
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.split("\r").findLast((segment) => segment.trim()) ?? "")
    .filter((line) => line.trim())
    .slice(-count)
    .join("\n");

/** A Markdown code block that the text's own backticks can't close early. */
export const codeBlock = (text: string) => {
  const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}\n${text}\n${fence}`;
};

/** The chat message "Fix with AI" sends. */
export const buildFixPrompt = (error: AppError, terminalOutput: string) => {
  const where = error.file ? ` in ${error.file}${error.line ? `:${error.line}` : ""}` : "";
  const parts = [
    `The preview shows a ${error.kind} error${where}. Find the cause and fix it.`,
    `Error:\n${codeBlock(error.message)}`,
  ];
  if (error.stack) parts.push(`Stack:\n${codeBlock(error.stack)}`);
  const tail = logTail(terminalOutput);
  if (tail) parts.push(`Last terminal lines:\n${codeBlock(tail)}`);
  return parts.join("\n\n");
};
