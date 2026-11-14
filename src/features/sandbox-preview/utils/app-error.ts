import { NOTHING_TO_PREVIEW } from "./boot-plan";
import { withErrorHints } from "./error-recipes";
import { ANSI_PATTERN } from "./last-log-line";
import type { SandboxErrorKind } from "./sandbox-error";

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
// The sandbox route's line for a failed install (#491).
const INSTALL_FAILED = /^Error: (.+ failed with exit code \d+)$/;
const NPM_ERROR_CODE = /npm (?:ERR!|error) code (\S+)/g;
// npm couldn't reach the registry, or it failed (5xx): the sandbox's network
// or the registry, not the app's dependencies. Also used by checkBuild. Only
// npm's own lines, so the app's earlier output can't hide a real failure.
export const NETWORK_FAILURE =
  /^\s*npm (?:ERR!|error) (?:network\b|.*?(?:\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|E5\d\d)\b|socket hang up))/m;
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
  const index = lines.findIndex(
    (line) => ERROR_LINE.test(line) || INSTALL_FAILED.test(line.trim()),
  );
  if (index === -1) return null;

  const install = lines[index].trim().match(INSTALL_FAILED);
  if (install) {
    const before = lines.slice(0, index).join("\n");
    if (NETWORK_FAILURE.test(before)) return null;
    // The last npm error code says which failure this is, e.g. ERESOLVE.
    const code = [...before.matchAll(NPM_ERROR_CODE)].at(-1)?.[1];
    const message = code ? `${install[1]} (${code})` : install[1];
    return { kind: "build", message: message.slice(0, MAX_ERROR_TEXT), file: "package.json" };
  }

  let message = lines[index].replace(LOG_PREFIX, "").trim();
  // "Transform failed with 1 error:" says nothing until the next line.
  const next = lines[index + 1]?.trim();
  if (message.endsWith(":") && next) message = `${message} ${next}`;

  // From the error on: the detector's tail can hold older lines with other paths.
  const fromError = lines.slice(index).join("\n");
  for (const pattern of FILE_PATTERNS) {
    const match = fromError.match(pattern);
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

/**
 * A sync's failed reinstall (#497): the line for the terminal, and the build
 * error it shows (none for a network failure), or null when the sync installed
 * nothing or succeeded. The route sends only the exit code and npm's code.
 */
export const readInstallFailure = (body: unknown, command: string) => {
  const failed = (body as { installFailed?: { exitCode?: unknown; code?: unknown } } | null)
    ?.installFailed;
  if (!failed || typeof failed.exitCode !== "number") return null;
  const code = typeof failed.code === "string" ? `npm error code ${failed.code}\n` : "";
  // The lines detectBuildError reads from the boot stream (#491).
  const output = `${code}Error: ${command} failed with exit code ${failed.exitCode}\n`;
  return { output, error: detectBuildError(output) };
};

// The overlay's location: "/home/user/app/src/App.tsx:3:20".
const OVERLAY_LOCATION = /^(.+?):(\d+)(?::\d+)?$/;

/** The build error Vite's error overlay shows, as the preview bridge reports it (#497). */
export const overlayError = (message: string, location?: string): AppError => {
  const where = location ? clean(location).trim() : "";
  const match = where.match(OVERLAY_LOCATION);
  return {
    kind: "build",
    message: clean(message).trim().slice(0, MAX_ERROR_TEXT) || "Build error",
    file: (match ? match[1] : where) || undefined,
    line: match ? Number(match[2]) : undefined,
  };
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

/**
 * A failed start the app's own output can explain, such as a failed npm
 * install (#491). Not a sandbox setup failure, and not a project with nothing
 * to preview: no fix to the code helps those.
 */
export const isAppStartFailure = (kind: SandboxErrorKind | null, message: string | null) =>
  kind === "transient" && message !== NOTHING_TO_PREVIEW;

/**
 * The shown error to fix without a click (#491), or null. Only once no run is
 * active and the chat is free; each error once, and at most `max` per session,
 * so a fix that fails can't loop. The banner's button stays for retries.
 */
export const autoFixTarget = (
  errorId: string | null,
  {
    runActive,
    chatBusy,
    sent,
    max,
  }: { runActive: boolean; chatBusy: boolean; sent: readonly string[]; max: number },
) =>
  errorId !== null && !runActive && !chatBusy && sent.length < max && !sent.includes(errorId)
    ? errorId
    : null;

/**
 * Fixes, without a click, the error the run that just ended left (#491).
 * Armed when a run ends, for `windowMs`; disarmed by the next run, and by any
 * file change after the run ended, which is the user's edit, not the run's. An
 * error must stay eligible for `delayMs`, so the run's last syncs can clear it.
 * `onFixingChange` says when a fix is pending, or sent and its run not over
 * (plus `delayMs` to settle) (#305); a sent fix that starts no run stops
 * counting after `windowMs`.
 * Call `update` on every change, `dispose` on unmount.
 */
export const createAutoFixer = ({
  delayMs,
  windowMs,
  max,
  onFixingChange = () => {},
}: {
  delayMs: number;
  windowMs: number;
  max: number;
  onFixingChange?: (fixing: boolean) => void;
}) => {
  const sent: string[] = [];
  // The latest `update`'s, so the fix sent is built from the error shown then.
  let fix: (errorId: string) => void = () => {};
  let wasRunActive = false;
  // The files when the last run ended; null when not armed.
  let armedFiles: unknown = null;
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  let fixTimer: ReturnType<typeof setTimeout> | undefined;
  let sentTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingId: string | null = null;
  // A fix was sent and the run it starts hasn't ended.
  let awaitingRun = false;
  let fixing = false;
  const report = () => {
    const next = pendingId !== null || awaitingRun;
    if (next === fixing) return;
    fixing = next;
    onFixingChange(fixing);
  };
  const stopAwaiting = () => {
    awaitingRun = false;
    report();
  };

  const schedule = (target: string | null) => {
    if (target === pendingId) return;
    clearTimeout(fixTimer);
    pendingId = target;
    if (target === null) return;
    fixTimer = setTimeout(() => {
      pendingId = null;
      awaitingRun = true;
      sent.push(target);
      fix(target);
      sentTimer = setTimeout(stopAwaiting, windowMs);
      report();
    }, delayMs);
  };
  const disarm = () => {
    armedFiles = null;
    clearTimeout(windowTimer);
    schedule(null);
  };

  return {
    update: ({
      errorId,
      runActive,
      chatBusy,
      files,
      fix: latestFix,
    }: {
      /** The shown error that may still be fixed, or null. */
      errorId: string | null;
      runActive: boolean;
      chatBusy: boolean;
      files: unknown;
      fix: (errorId: string) => void;
    }) => {
      fix = latestFix;
      if (runActive !== wasRunActive) {
        wasRunActive = runActive;
        disarm();
        clearTimeout(sentTimer);
        if (!runActive) {
          // The fix run's last syncs get the same delay to clear its error.
          if (awaitingRun) {
            sentTimer = setTimeout(stopAwaiting, delayMs);
          }
          armedFiles = files ?? null;
          windowTimer = setTimeout(() => {
            disarm();
            report();
          }, windowMs);
        }
      } else if (armedFiles !== null && files !== armedFiles) {
        disarm();
      }
      schedule(
        armedFiles === null ? null : autoFixTarget(errorId, { runActive, chatBusy, sent, max }),
      );
      report();
    },
    dispose: () => {
      clearTimeout(windowTimer);
      clearTimeout(sentTimer);
      schedule(null);
    },
  };
};

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
  return withErrorHints(parts.join("\n\n"));
};
