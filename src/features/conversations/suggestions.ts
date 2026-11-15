/**
 * Next steps a build reply ends with (#256), in a `<suggestions>` block of one
 * per line. They become chips under the reply; the block itself is never
 * shown, closed or not. A line may start with an action tag (`[publish]`).
 */

export const MAX_SUGGESTIONS = 4;
export const MAX_SUGGESTION_CHARS = 100;

// A block runs to its closing tag, or to the end of a cut-off reply.
const BLOCK = /<suggestions>([\s\S]*?)(?:<\/suggestions>|$)/gi;
const STRAY_TAG = /<\/?suggestions>/gi;
const LIST_MARK = /^(?:[-*•]|\d+[.)])\s+/;
const QUOTES = /^["'`]+|["'`]+$/g;

/** The reply without its suggestions block, and the block's prompts. */
export const splitSuggestions = (reply: string) => {
  const lines = [...reply.matchAll(BLOCK)].flatMap((match) => match[1].split("\n"));
  const prompts = lines
    .map((line) => line.trim().replace(LIST_MARK, "").replace(QUOTES, "").trim())
    .filter((line) => line && line.length <= MAX_SUGGESTION_CHARS);
  // Unique, so a repeated line is one chip.
  const suggestions = [...new Set(prompts)].slice(0, MAX_SUGGESTIONS);
  return { content: reply.replace(BLOCK, "").replace(STRAY_TAG, "").trim(), suggestions };
};

/** The IDE action a tagged chip opens. */
export type SuggestionAction = { kind: "connect"; providerId: string } | { kind: "publish" } | { kind: "env-vars" };

const ACTION_TAG = /^\[(?:connect:([a-z0-9-]+)|(publish|env-vars))\]\s*/i;

/**
 * A chip's label, and the action its tag names. An untagged line, or a tag
 * with no label, is a prompt chip.
 */
export const parseSuggestion = (line: string): { label: string; action: SuggestionAction | null } => {
  const match = line.match(ACTION_TAG);
  const label = line.slice(match?.[0].length ?? 0).trim();
  if (!match || !label) return { label: line, action: null };
  const [, providerId, kind] = match;
  if (providerId) return { label, action: { kind: "connect", providerId: providerId.toLowerCase() } };
  return { label, action: { kind: kind.toLowerCase() as "publish" | "env-vars" } };
};
