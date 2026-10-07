import { SKILL_NAME_MAX_LENGTH, SKILL_NAME_PATTERN } from "./limits";

/** Skills one message can force with leading `/name` tokens. */
export const MAX_SLASH_SKILLS = 3;

// One leading `/name` token and the whitespace after it. The name must end at
// whitespace or the end of the text, so a path like `/src/app` never matches.
const SLASH_TOKEN = new RegExp(
  `^/(${SKILL_NAME_PATTERN.source.slice(1, -1)})(?=\\s|$)\\s*`,
);

/**
 * Splits a message's leading `/name` tokens (at most `MAX_SLASH_SKILLS`) from
 * the rest of the text. Slashes later in the text are left alone.
 */
export function splitSlashSkills(text: string): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = text.trimStart();
  for (let tokens = 0; tokens < MAX_SLASH_SKILLS; tokens += 1) {
    const match = rest.match(SLASH_TOKEN);
    if (!match || match[1].length > SKILL_NAME_MAX_LENGTH) break;
    if (!names.includes(match[1])) names.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return { names, rest: names.length > 0 ? rest : text };
}

/** The skill names a message forces with leading `/name` tokens. */
export const parseSlashSkills = (text: string) => splitSlashSkills(text).names;
