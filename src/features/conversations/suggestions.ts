/**
 * Follow-up prompts a build reply ends with (#256), in a `<suggestions>` block
 * of one prompt per line. They become chips under the reply; the block itself
 * is never shown, closed or not.
 */

export const MAX_SUGGESTIONS = 3;
export const MAX_SUGGESTION_CHARS = 100;

// A block runs to its closing tag, or to the end of a cut-off reply.
const BLOCK = /<suggestions>([\s\S]*?)(?:<\/suggestions>|$)/gi;
const STRAY_TAG = /<\/?suggestions>/gi;
const LIST_MARK = /^(?:[-*•]|\d+[.)])\s+/;
const QUOTES = /^["'`]+|["'`]+$/g;

/** The reply without its suggestions block, and the block's prompts. */
export const splitSuggestions = (reply: string) => {
  const lines = [...reply.matchAll(BLOCK)].flatMap((match) => match[1].split("\n"));
  const suggestions = lines
    .map((line) => line.trim().replace(LIST_MARK, "").replace(QUOTES, "").trim())
    .filter((line) => line && line.length <= MAX_SUGGESTION_CHARS)
    .slice(0, MAX_SUGGESTIONS);
  return { content: reply.replace(BLOCK, "").replace(STRAY_TAG, "").trim(), suggestions };
};
