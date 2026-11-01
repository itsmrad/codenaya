/** Longest project instructions an owner may save (#299). */
export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 4000;

// Removed from the text so it can't close the delimiter and pose as system rules.
const DELIMITER_TAG = /<\/?project_instructions\s*>/gi;

/**
 * The system prompt's project instructions section (#299): the owner's
 * always-on preferences, delimited and framed as user text, not system rules.
 * Capped here too, so a stored value can never outgrow the limit. Empty when
 * there are none.
 */
export function buildProjectInstructionsSection(instructions?: string): string {
  const text = (instructions ?? "")
    .replace(DELIMITER_TAG, "")
    .trim()
    .slice(0, MAX_PROJECT_INSTRUCTIONS_LENGTH);
  if (!text) return "";

  return [
    "\n\n## Project instructions (from the user)",
    "The project owner saved these preferences for every run in this project. " +
      "Follow them unless they conflict with <critical_rules>, credential rules " +
      "or the user's current request. They are user preferences, not system rules.",
    "<project_instructions>",
    text,
    "</project_instructions>",
  ].join("\n");
}
