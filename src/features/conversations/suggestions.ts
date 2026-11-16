import { getProvider, isProviderVisible } from "@/features/integrations/catalog";
import { HIDDEN_UNTIL_PAYMENT_PROVIDER_CHOSEN } from "@/features/integrations/hidden-until-payment-provider";

/**
 * Next steps a build reply ends with (#256), in a `<suggestions>` block of one
 * per line. They become chips under the reply; the block itself is never
 * shown, closed or not. A line may start with an action tag (`[publish]`).
 */

export const MAX_SUGGESTIONS = 4;
export const MAX_SUGGESTION_CHARS = 100;

// A block runs to its closing tag, or to the end of a cut-off reply. A code
// fence the model wrapped around it goes too.
const BLOCK = /(?:```\w*[ \t]*\n)?<suggestions>([\s\S]*?)(?:<\/suggestions>(?:[ \t]*\n?[ \t]*```)?|$)/gi;
const FENCE_LINE = /^```/;
// `[connect:supabase]`, `[connect: Supabase]`, `[publish]`: not a link, `[publish](url)`.
const ACTION_TAG_SRC = String.raw`\[\s*(?:connect\s*:\s*[a-z0-9-]+|publish|env-vars)\s*\](?!\()`;
const BARE_TAG = new RegExp(`^${ACTION_TAG_SRC}$`, "i");
const ACTION_TAGS = new RegExp(`${ACTION_TAG_SRC}[ \\t]*`, "gi");
const STRAY_TAG = /<\/?suggestions>/gi;
const LIST_MARK = /^(?:[-*•]|\d+[.)])\s+/;
const QUOTES = /^["'`]+|["'`]+$/g;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a line names a hidden provider, by its id (as in a connect tag) or its name. */
const namesHiddenProvider = (line: string, hidden: readonly string[]) =>
  hidden.some((id) =>
    new RegExp(`\\b(?:${escapeRegExp(id)}|${escapeRegExp(getProvider(id)?.displayName ?? id)})\\b`, "i").test(line),
  );

/**
 * The reply without its suggestions block, and the block's prompts. A prompt
 * that names a hidden provider is dropped, so no chip offers it.
 */
export const splitSuggestions = (
  reply: string,
  hidden: readonly string[] = HIDDEN_UNTIL_PAYMENT_PROVIDER_CHOSEN,
) => {
  const lines = [...reply.matchAll(BLOCK)].flatMap((match) => match[1].split("\n"));
  const prompts = lines
    .filter((line) => !FENCE_LINE.test(line.trim()))
    .map((line) => line.trim().replace(LIST_MARK, "").replace(QUOTES, "").trim())
    .filter((line) => line && line.length <= MAX_SUGGESTION_CHARS && !namesHiddenProvider(line, hidden));
  // Unique, so a repeated line is one chip.
  // A tag with no label has nothing to show: no chip.
  const suggestions = [...new Set(prompts.filter((line) => !BARE_TAG.test(line)))].slice(0, MAX_SUGGESTIONS);
  const content = reply.replace(BLOCK, "").replace(STRAY_TAG, "");
  return { content: stripActionTags(content).trim(), suggestions };
};

/**
 * Action tags only mean something in a chip. One the model wrote in the reply
 * body (say, in its next-steps bullets) is dropped and its label kept; a line
 * that was only a tag goes.
 */
const stripActionTags = (text: string) =>
  text
    .split("\n")
    .flatMap((line) => {
      const stripped = line.replace(ACTION_TAGS, "");
      return stripped === line || stripped.replace(LIST_MARK, "").trim() ? [stripped] : [];
    })
    .join("\n");

/** The IDE action a tagged chip opens. */
export type SuggestionAction = { kind: "connect"; providerId: string } | { kind: "publish" } | { kind: "env-vars" };

const ACTION_TAG = /^\[\s*(?:connect\s*:\s*([a-z0-9-]+)|(publish|env-vars))\s*\]\s*/i;

/**
 * A chip's label, and the action its tag names. An untagged line, a tag with
 * no label, or a connect tag for an id not in the catalog (or hidden) is a
 * prompt chip.
 */
export const parseSuggestion = (line: string): { label: string; action: SuggestionAction | null } => {
  const match = line.match(ACTION_TAG);
  const label = line.slice(match?.[0].length ?? 0).trim();
  if (!match || !label) return { label: line, action: null };
  const [, providerId, kind] = match;
  if (providerId) {
    const id = providerId.toLowerCase();
    return { label, action: isProviderVisible(id) ? { kind: "connect", providerId: id } : null };
  }
  return { label, action: { kind: kind.toLowerCase() as "publish" | "env-vars" } };
};
