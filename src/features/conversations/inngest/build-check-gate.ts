import { BUILD_CHECK_UNFINISHED, toolResultError } from "../agent-steps";

/**
 * Keeps a run from ending with files changed since its last passing
 * checkBuild: the prompt asks for the check, and this enforces it once.
 */

/** Tools that change what the build sees. */
const WRITE_TOOLS = new Set([
  "writeFiles",
  "createFiles",
  "updateFile",
  "editFile",
  "renameFile",
  "deleteFiles",
  "scaffoldViteApp",
]);

/** Write tools that make at most one (transactional) mutation, so an error result means nothing changed. */
const ATOMIC_WRITE_TOOLS = new Set(["updateFile", "editFile", "renameFile"]);

/** One check plus the two fix attempts the prompt allows. */
export const MAX_BUILD_CHECKS = 3;

// The reply after this turn replaces the summary, so it asks for it again.
export const BUILD_CHECK_NUDGE =
  "Files changed since the last build check. Run checkBuild, then give the complete final summary again.";

type ToolCalls = { toolCalls: Array<{ tool: { name: string }; content: unknown }> };

/**
 * Whether files changed after the last checkBuild that passed or could not
 * run, with a check left to spend.
 */
/** Whether a write in the run succeeded: a seeded project's first build is done (#338). */
export const wroteFiles = (results: ToolCalls[]) =>
  results.some(({ toolCalls }) =>
    toolCalls.some(({ tool, content }) => WRITE_TOOLS.has(tool.name) && toolResultError(content) === undefined),
  );

export const hasUncheckedWrites = (results: ToolCalls[]) => {
  let unchecked = false;
  let checks = 0;
  for (const { tool, content } of results.flatMap((result) => result.toolCalls)) {
    if (WRITE_TOOLS.has(tool.name)) {
      // Multi-mutation tools may have written some files before failing.
      if (!ATOMIC_WRITE_TOOLS.has(tool.name) || toolResultError(content) === undefined) unchecked = true;
    } else if (tool.name === "checkBuild") {
      checks += 1;
      // A check that could not run is not retried: the agent reports it instead.
      const error = toolResultError(content);
      if (error === undefined || error.startsWith(BUILD_CHECK_UNFINISHED)) unchecked = false;
    }
  }
  return unchecked && checks < MAX_BUILD_CHECKS;
};

/**
 * Per run: `shouldContinue` on a text-only turn routes back to the agent at
 * most once, and `takeNudge` hands that turn its note.
 */
export const createBuildCheckGate = () => {
  let forced = false;
  let nudge: string | undefined;
  return {
    shouldContinue(results: ToolCalls[]) {
      if (forced || !hasUncheckedWrites(results)) return false;
      forced = true;
      nudge = BUILD_CHECK_NUDGE;
      return true;
    },
    takeNudge() {
      const pending = nudge;
      nudge = undefined;
      return pending;
    },
  };
};
