import { BUILD_CHECK_UNFINISHED, BUILD_VERIFIED, buildCheckLabel, toolResultError } from "../agent-steps";
import { OUTPUT_LIMIT_ERROR } from "./lib/output-limit";

/**
 * Keeps a run from ending with files changed since its last passing
 * checkBuild: the prompt asks for the check, and this enforces it, with a
 * bounded number of repair turns when it fails.
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
  "delegateTasks",
]);

/**
 * Write tools whose error result means nothing changed: one (transactional) mutation, or a
 * delegateTasks call that was refused or whose workers wrote nothing.
 */
const ATOMIC_WRITE_TOOLS = new Set(["updateFile", "editFile", "renameFile", "delegateTasks"]);

/** One check plus the two fix attempts the prompt allows; also caps the turns the gate forces. */
export const MAX_BUILD_CHECKS = 3;

/** Steps before the summary turn kept for check, fix, check, fix, check. */
export const BUILD_CHECK_RESERVE_STEPS = 2 * MAX_BUILD_CHECKS - 1;

// The reply after these turns replaces the summary, so they ask for it again.
export const BUILD_CHECK_NUDGE =
  "Files changed since the last build check. Run checkBuild, then give the complete final summary again.";
export const BUILD_REPAIR_NUDGE =
  "The last build check failed. Fix the errors it reported, run checkBuild again, then give the complete final summary again.";
export const BUILD_RETRY_NUDGE =
  "The last build check could not finish, most likely because the preview was still installing packages. Run checkBuild again now without changing files, then give the complete final summary again.";
export const BUILD_RESERVE_NUDGE =
  "Only a few steps are left. Stop adding features: run checkBuild now, fix what it reports, then give the final summary.";

// Added to the reply of a run whose changes did not end on a verified build.
export const BUILD_FAILED_NOTE =
  "**Build check:** The build still has errors after the fix attempts this run allows, so the preview may not work yet. Ask me to fix the build errors to try again.";
export const BUILD_UNVERIFIED_NOTE =
  "**Build check:** The build was not verified after the last changes, so the preview may not work yet. Ask me to check the build to verify it.";
// Another check would not build it either (no build sandbox, or a framework checkBuild does not build).
export const BUILD_NOT_BUILT_NOTE =
  "**Build check:** Static checks passed, but the app could not be built here, so it has not been verified. Check the preview before relying on it.";
// The run ended on a failed or missing check, and the repair after it passed.
export const BUILD_REPAIRED_NOTE =
  "**Build check:** The build had errors after these changes, so they were fixed automatically; the type check and production build now pass.";

type ToolCalls = { toolCalls: Array<{ tool: { name: string }; content: unknown }> };

/** Whether a write in the run succeeded: a seeded project's first build is done (#338). */
export const wroteFiles = (results: ToolCalls[]) =>
  results.some(({ toolCalls }) =>
    toolCalls.some(({ tool, content }) => WRITE_TOOLS.has(tool.name) && toolResultError(content) === undefined),
  );

/**
 * What the run's writes left: whether any may have changed files, the result
 * of the latest check after them, and how many checks ran. A check that
 * passed without building ("Static checks passed", "Build not checked") is
 * "unverified": nothing to fix, but not a working build either.
 */
const buildState = (results: ToolCalls[]) => {
  let wrote = false;
  let last: "unchecked" | "passed" | "unverified" | "failed" | "unfinished" = "unchecked";
  let checks = 0;
  for (const { tool, content } of results.flatMap((result) => result.toolCalls)) {
    if (WRITE_TOOLS.has(tool.name)) {
      // A refused cut-off call changed nothing.
      if ((content as { data?: unknown } | null)?.data === OUTPUT_LIMIT_ERROR) continue;
      // Multi-mutation tools may have written some files before failing.
      if (!ATOMIC_WRITE_TOOLS.has(tool.name) || toolResultError(content) === undefined) {
        wrote = true;
        last = "unchecked";
      }
    } else if (tool.name === "checkBuild") {
      checks += 1;
      const error = toolResultError(content);
      if (error !== undefined) last = error.startsWith(BUILD_CHECK_UNFINISHED) ? "unfinished" : "failed";
      else last = buildCheckLabel(content) === BUILD_VERIFIED ? "passed" : "unverified";
    }
  }
  return { wrote, last, checks };
};

/**
 * Whether files changed after the last checkBuild that passed or could not
 * run, or the check after them failed, with a check left to spend.
 */
export const hasUncheckedWrites = (results: ToolCalls[]) => {
  const { wrote, last, checks } = buildState(results);
  // A check that could not run is retried at most once, by the gate below.
  return wrote && (last === "unchecked" || last === "failed") && checks < MAX_BUILD_CHECKS;
};

/**
 * Whether the run's writes ended on a failed check, or on none (the step
 * budget ran out): a repair after the run may still fix and verify them.
 * Not for checks that could not build or finish; another would not either.
 */
export const needsBuildRepair = (results: ToolCalls[]) => {
  const { wrote, last } = buildState(results);
  return wrote && (last === "failed" || last === "unchecked");
};

/** The note for a run whose changes did not end on a verified build, if any. */
export const unverifiedBuildNote = (results: ToolCalls[]) => {
  const { wrote, last } = buildState(results);
  if (!wrote || last === "passed") return undefined;
  if (last === "failed") return BUILD_FAILED_NOTE;
  return last === "unverified" ? BUILD_NOT_BUILT_NOTE : BUILD_UNVERIFIED_NOTE;
};

/**
 * Per run: `shouldContinue` on a text-only turn routes back to the agent at
 * most MAX_BUILD_CHECKS times, once of them to retry a check that could not
 * finish (the preview's install is usually done by then, so the retry builds
 * in the warm sandbox), `reserve` asks once for the check near the
 * step budget's end, and `takeNudge` hands the next turn its note.
 */
export const createBuildCheckGate = () => {
  let forced = 0;
  let repairs = 0;
  let reserved = false;
  let retried = false;
  let nudge: string | undefined;
  return {
    shouldContinue(results: ToolCalls[]) {
      if (forced >= MAX_BUILD_CHECKS) return false;
      const { wrote, last, checks } = buildState(results);
      const retry = !retried && wrote && last === "unfinished" && checks < MAX_BUILD_CHECKS;
      if (!retry && !hasUncheckedWrites(results)) return false;
      forced += 1;
      if (retry) retried = true;
      if (last === "failed") repairs += 1;
      nudge = retry ? BUILD_RETRY_NUDGE : last === "failed" ? BUILD_REPAIR_NUDGE : BUILD_CHECK_NUDGE;
      return true;
    },
    reserve(results: ToolCalls[]) {
      if (reserved || !hasUncheckedWrites(results)) return;
      reserved = true;
      nudge = BUILD_RESERVE_NUDGE;
    },
    takeNudge() {
      const pending = nudge;
      nudge = undefined;
      return pending;
    },
    /** Fix turns forced after a failed check so far, for the run block's repair steps. */
    get repairs() {
      return repairs;
    },
  };
};
