/** Longest project instructions an owner may save (#299). */
export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 4000;

// Any form of the delimiter tag (spaces, attributes, any case, unterminated),
// removed from the text so it can't close the delimiter and pose as system
// rules. It stops at a line end, so an unclosed tag can't swallow later lines.
const DELIMITER_TAG = /<\s*\/?\s*project_instructions\b[^<>\n]*>?/gi;

/** Strips delimiter tags until none are left, so nested ones can't rebuild a tag. */
const stripDelimiterTags = (text: string): string => {
  const stripped = text.replace(DELIMITER_TAG, "");
  return stripped === text ? text : stripDelimiterTags(stripped);
};

/**
 * The system prompt's project instructions section (#299): the owner's
 * always-on preferences, delimited and framed as user text, not system rules.
 * Capped here too, so a stored value can never outgrow the limit. Empty when
 * there are none.
 */
export function buildProjectInstructionsSection(instructions?: string): string {
  const text = stripDelimiterTags(instructions ?? "")
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
