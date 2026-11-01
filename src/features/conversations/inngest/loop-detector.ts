import {
  STUCK_REASONS,
  type StuckRun,
  sanitizeAgentText,
  toolResultError,
} from "../agent-steps";
import { SYNTAX_ERRORS_NOTE } from "./tools/syntax-error";

/**
 * Stops a run going in circles (#306): the same tool error, rewrites of one
 * file, or one file that keeps failing to parse. Pure; the router calls it
 * after every turn that made tool calls.
 */

export const MAX_SAME_ERROR = 3;
export const MAX_SAME_FILE_WRITES = 4;
export const MAX_SAME_SYNTAX_ERROR = 3;

/** Written when the stuck run's last turn gave no text. */
export const STUCK_FALLBACK_REPLY =
  "I got stuck going in circles on this, so I stopped early. You can restore the files, retry on another model, or diagnose the problem in Plan mode.";

/** Sent once when this run hits the error the previous run got stuck on. */
export const PREVIOUS_ERROR_HINT =
  "The previous fix attempt failed with the same error; change approach or ask the user.";

/** The last turn's note, in place of the step budget note. */
export const stuckNote = ({ reason, error }: StuckRun) =>
  `You are going in circles: ${STUCK_REASONS[reason]}${error ? ` ("${error}")` : ""}. ` +
  "The run stops here: no more tool calls. In a few short lines, say what you tried, " +
  "what still fails and what the user could try next. Do not claim it is fixed.";

// AgentKit leaves a result's `tool.input` empty; the turn's tool_call output has it.
type ToolResults = {
  output: Array<{ type: string; tools?: Array<{ id: string; input?: unknown }> }>;
  toolCalls: Array<{ tool: { id: string; name: string }; content: unknown }>;
};

/** Each tool call of the run with its input. */
const runCalls = (results: ToolResults[]) =>
  results.flatMap(({ output, toolCalls }) => {
    const inputs = new Map(
      output.flatMap((m) => (m.type === "tool_call" ? m.tools ?? [] : [])).map((t) => [t.id, t.input]),
    );
    return toolCalls.map(({ tool, content }) => ({ tool, content, input: inputs.get(tool.id) }));
  });

/** An error with its ids, numbers (lines, columns, counts) and case evened out. */
export const errorSignature = (error: string) =>
  sanitizeAgentText(error).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** `[file name, entry]` for each file a write tool's syntax note reports. */
const syntaxErrors = (content: unknown): Array<[string, string]> => {
  const data = (content as { data?: unknown } | null)?.data;
  const at = typeof data === "string" ? data.indexOf(SYNTAX_ERRORS_NOTE) : -1;
  if (at === -1) return [];
  return (data as string)
    .slice(at + SYNTAX_ERRORS_NOTE.length)
    .split("; ")
    .map((entry) => [/^(.*?) \d+:\d+ /.exec(entry)?.[1] ?? entry.split(" ")[0], entry]);
};

/** Every error a call reported: its own failure, or the syntax errors it wrote. */
const callErrors = (content: unknown) => {
  const error = toolResultError(content);
  return error ? [error] : syntaxErrors(content).map(([, entry]) => entry);
};

/** The first loop in the run's tool calls, or null while it makes progress. */
export const detectLoop = (results: ToolResults[]): StuckRun | null => {
  const counts = new Map<string, number>();
  const bump = (key: string) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  };

  for (const { tool, content, input: raw } of runCalls(results)) {
    const input = (raw ?? {}) as { fileId?: unknown };
    const fileId =
      tool.name === "updateFile" && typeof input.fileId === "string" ? input.fileId : undefined;
    const file = fileId ? { fileId } : {};

    const error = toolResultError(content);
    if (error) {
      const signature = errorSignature(error);
      if (bump(`error:${signature}`) >= MAX_SAME_ERROR) {
        return { reason: "repeated-error", error, signature, ...file };
      }
      continue;
    }
    if (fileId && bump(`write:${fileId}`) >= MAX_SAME_FILE_WRITES) {
      return { reason: "repeated-write", fileId };
    }
    for (const [name, entry] of syntaxErrors(content)) {
      if (bump(`syntax:${name}`) >= MAX_SAME_SYNTAX_ERROR) {
        const shown = sanitizeAgentText(entry).slice(0, 200);
        return { reason: "repeated-syntax-error", error: shown, signature: errorSignature(entry), ...file };
      }
    }
  }
  return null;
};

/** Whether any call in the run reported an error with this signature. */
export const repeatsError = (results: ToolResults[], signature: string) =>
  runCalls(results).some(({ content }) =>
    callErrors(content).some((error) => errorSignature(error) === signature),
  );

/**
 * Per run: `check` after each tool turn finds a loop (kept once found) and
 * queues the one-time hint when the run repeats `previousSignature`, the error
 * the previous run got stuck on; `takeHint` hands a turn that hint.
 */
export const createLoopGuard = (previousSignature?: string) => {
  let stuck: StuckRun | null = null;
  let hinted = false;
  let hint: string | undefined;
  return {
    get stuck() {
      return stuck;
    },
    check(results: ToolResults[]) {
      stuck ??= detectLoop(results);
      if (!hinted && previousSignature && repeatsError(results, previousSignature)) {
        hinted = true;
        hint = PREVIOUS_ERROR_HINT;
      }
      return stuck;
    },
    takeHint() {
      const pending = hint;
      hint = undefined;
      return pending;
    },
  };
};
