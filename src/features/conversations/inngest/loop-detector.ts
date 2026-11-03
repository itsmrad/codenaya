import {
  BUILD_CHECK_UNFINISHED,
  BUILD_VERIFIED,
  MAX_SAME_ERROR,
  MAX_SAME_FILE_WRITES,
  MAX_SAME_SYNTAX_ERROR,
  STUCK_REASONS,
  type StuckRun,
  buildCheckLabel,
  normalizePath,
  sanitizeAgentText,
  toolResultError,
} from "../agent-steps";
import { SYNTAX_ERRORS_NOTE } from "./tools/syntax-error";

/**
 * Stops a run going in circles (#306): the same tool error, rewrites of one
 * file that keep failing, or one file that keeps failing to parse. Pure; the
 * router calls it after every turn that made tool calls.
 */

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

interface Call {
  name: string;
  input: Record<string, unknown>;
  content: unknown;
}

/** Each tool call of the run with its input. */
const runCalls = (results: ToolResults[]): Call[] =>
  results.flatMap(({ output, toolCalls }) => {
    const inputs = new Map(
      output.flatMap((m) => (m.type === "tool_call" ? m.tools ?? [] : [])).map((t) => [t.id, t.input]),
    );
    return toolCalls.map(({ tool, content }) => ({
      name: tool.name,
      input: (inputs.get(tool.id) ?? {}) as Record<string, unknown>,
      content,
    }));
  });

const str = (value: unknown) => (typeof value === "string" ? value : "");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An error with its ids, numbers (lines, columns, counts) and case evened out. */
export const errorSignature = (error: string) =>
  sanitizeAgentText(error).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** A file a write call wrote: its count key, the name its syntax note uses, and how the card opens it. */
interface WrittenFile {
  key: string;
  label: string;
  ref: { fileId?: string; path?: string };
}

const byPath = (raw: string): WrittenFile | undefined => {
  const path = normalizePath(raw);
  return path ? { key: `path:${path}`, label: path, ref: { path } } : undefined;
};

/**
 * The files a write call wrote. updateFile and writeFiles name them by path
 * (#292), so both count toward the same file; updateFile calls made before
 * #292 by id; createFiles by parent and name.
 */
const writtenFiles = ({ name, input }: Call): WrittenFile[] => {
  const files = (Array.isArray(input.files) ? input.files : []) as Array<Record<string, unknown> | null>;
  if (name === "updateFile") {
    const file = byPath(str(input.path));
    if (file) return [file];
    const fileId = str(input.fileId);
    return fileId ? [{ key: `id:${fileId}`, label: "", ref: { fileId } }] : [];
  }
  if (name === "writeFiles") return files.flatMap((file) => byPath(str(file?.path)) ?? []);
  if (name === "createFiles") {
    return files
      .map((file) => str(file?.name))
      .filter(Boolean)
      .map((fileName) => ({ key: `parent:${str(input.parentId)}/${fileName}`, label: fileName, ref: {} }));
  }
  return [];
};

/** Rewrites of these replace whole files; createFiles of an existing name fails instead. */
const REWRITE_TOOLS = new Set(["updateFile", "writeFiles"]);

/**
 * Each file a write call's syntax note reports, with its entry. A call that
 * wrote one file has one entry: its whole note. Otherwise the note is split
 * only before a name the call wrote, so a "; " inside a message can't split one.
 */
const syntaxErrors = (content: unknown, written: WrittenFile[]): Array<[WrittenFile, string]> => {
  const data = str((content as { data?: unknown } | null)?.data);
  const at = data.indexOf(SYNTAX_ERRORS_NOTE);
  if (at === -1) return [];
  const note = data.slice(at + SYNTAX_ERRORS_NOTE.length).trim();
  const unknown = (entry: string): WrittenFile => ({ key: `note:${entry}`, label: "", ref: {} });
  if (written.length <= 1) return [[written[0] ?? unknown(note), note]];

  const labels = written.map((file) => escapeRegExp(file.label)).join("|");
  return note
    .split(new RegExp(`; (?=(?:${labels}) )`))
    .map((entry) => [written.find((file) => entry.startsWith(`${file.label} `)) ?? unknown(entry), entry]);
};

/** Every error a call reported: its own failure, or the syntax errors it wrote. */
const callErrors = (call: Call) => {
  const error = toolResultError(call.content);
  return error ? [error] : syntaxErrors(call.content, writtenFiles(call)).map(([, entry]) => entry);
};

/** The first loop in the run's tool calls, or null while it makes progress. */
export const detectLoop = (results: ToolResults[]): StuckRun | null => {
  const errors = new Map<string, number>();
  const syntax = new Map<string, number>();
  // Per file: rewrites made after a failure, and whether one followed its last write.
  // A rewrite replaces the whole file, so rewrites alone are normal for hub files.
  const writes = new Map<string, { count: number; failed: boolean }>();
  const bump = (counts: Map<string, number>, key: string) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  };
  const markFailed = () => {
    for (const write of writes.values()) write.failed = true;
  };

  for (const call of runCalls(results)) {
    const written = writtenFiles(call);
    // The file an error is about, when the call wrote just one.
    const file = written.length === 1 ? written[0].ref : {};

    const error = toolResultError(call.content);
    if (error) {
      // A check that could not run (a sandbox timeout) says nothing about the code.
      if (call.name === "checkBuild" && error.startsWith(BUILD_CHECK_UNFINISHED)) continue;
      markFailed();
      const signature = errorSignature(error);
      if (bump(errors, signature) >= MAX_SAME_ERROR) {
        return { reason: "repeated-error", error, signature, ...file };
      }
      continue;
    }
    const passed = call.name === "checkBuild" ? buildCheckLabel(call.content) : undefined;
    if (passed) {
      // Any pass ends the rewrite counts, so runs without a sandbox keep going;
      // only a real build proves the code parses and the errors are gone.
      writes.clear();
      if (passed === BUILD_VERIFIED) {
        syntax.clear();
        errors.clear();
      }
      continue;
    }

    const notes = syntaxErrors(call.content, written);
    if (REWRITE_TOOLS.has(call.name)) {
      for (const { key, ref } of written) {
        const previous = writes.get(key);
        const count = previous ? previous.count + (previous.failed ? 1 : 0) : 1;
        writes.set(key, { count, failed: false });
        if (count >= MAX_SAME_FILE_WRITES) return { reason: "repeated-write", ...ref };
      }
    }
    if (notes.length > 0) markFailed();
    // A file written again without a syntax note was fixed.
    const broken = new Set(notes.map(([{ key }]) => key));
    for (const { key } of written) {
      if (!broken.has(key)) syntax.delete(key);
    }
    for (const [{ key, ref }, entry] of notes) {
      if (bump(syntax, key) >= MAX_SAME_SYNTAX_ERROR) {
        const shown = sanitizeAgentText(entry).slice(0, 200);
        return { reason: "repeated-syntax-error", error: shown, signature: errorSignature(entry), ...ref };
      }
    }
  }
  return null;
};

/** Whether any call in the run reported an error with this signature. */
export const repeatsError = (results: ToolResults[], signature: string) =>
  runCalls(results).some((call) =>
    callErrors(call).some((error) => errorSignature(error) === signature),
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
