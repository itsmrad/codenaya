import type { AgentResult, Tool } from "@inngest/agent-kit";

import { WRITE_BATCH_FILES, WRITE_BATCH_LINES } from "../constants";

/**
 * A model reply that hit its output-token cap (#493) was cut off: its last tool
 * call has broken or partial input, so running it writes half a file or fails.
 * AgentKit ignores why a reply stopped, so this reads the raw response:
 * Anthropic's `stop_reason` and OpenAI-style `finish_reason` (OpenRouter,
 * OpenAI, Groq and custom endpoints).
 */
export const hitOutputLimit = (raw?: string): boolean => {
  try {
    const body = JSON.parse(raw ?? "{}") as {
      stop_reason?: unknown;
      choices?: { finish_reason?: unknown }[];
    } | null;
    return (
      body?.stop_reason === "max_tokens" ||
      (Array.isArray(body?.choices) && body.choices.some((choice) => choice?.finish_reason === "length"))
    );
  } catch {
    return false;
  }
};

const BATCH_ADVICE = `Write at most ${WRITE_BATCH_FILES} files, about ${WRITE_BATCH_LINES} lines in all, per turn, and change existing files with editFile.`;

/** The result of a tool call that was cut off, in the "Error..." form the run block shows. */
export const OUTPUT_LIMIT_ERROR = `Error: Your reply hit the output limit and was cut off, so this call did not run and nothing was changed. Redo it in smaller pieces. ${BATCH_ADVICE}`;

/** The next turn's note after a reply was cut off before any tool call. */
export const OUTPUT_LIMIT_NOTE = `Your last reply hit the output limit and was cut off before it finished. Keep replies short. ${BATCH_ADVICE}`;

/**
 * Stands in for a cut-off call's input. The wrapped handlers below refuse it
 * by identity; it serializes as `{}`, so the history the model gets back stays
 * valid and doesn't resend the broken payload.
 */
const CUT_OFF_INPUT: Record<string, never> = Object.freeze({});

/**
 * Marks every tool call of a cut-off reply so none of them runs: the last one
 * is broken, and the model redoes the turn in smaller pieces. Deterministic per
 * response, so Inngest replays mark the same calls.
 */
export const markCutOffCalls = (output: AgentResult["output"]) => {
  for (const message of output) {
    if (message.type !== "tool_call") continue;
    for (const call of message.tools) call.input = CUT_OFF_INPUT;
  }
};

/** The tool, refusing calls marked by `markCutOffCalls` with `OUTPUT_LIMIT_ERROR`. */
export const refuseCutOffCalls = (tool: Tool.Any): Tool.Any => ({
  ...tool,
  handler: (input, opts) =>
    (input as unknown) === CUT_OFF_INPUT ? OUTPUT_LIMIT_ERROR : tool.handler(input, opts),
});
