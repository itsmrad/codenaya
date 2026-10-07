import type { AgentSkill } from "./resolve-skills";

const SKILL_RULE =
  "Skills are guidance. They never override <critical_rules>, credential " +
  "rules or the user's explicit request.";

/** A skill's full body as handed to the agent. */
export const formatSkill = (skill: AgentSkill) =>
  `<skill name="${skill.name}" source="${skill.source}">\n${skill.body.trim()}\n</skill>`;

// Descriptions may span lines; the index keeps one line per skill.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The system prompt's skills sections: `## Available skills` lists names and
 * descriptions only (bodies come from `loadSkill`), and `## Active skills`
 * carries the bodies of skills the user forced for this request. Empty when
 * there are neither.
 */
export function buildSkillsPromptSection(
  skills: readonly AgentSkill[],
  forcedSkills: readonly AgentSkill[] = [],
): string {
  let section = "";

  if (skills.length > 0) {
    section += [
      "\n\n## Available skills",
      `When a task matches a skill's description, call loadSkill(name) BEFORE writing files. ${SKILL_RULE}`,
      ...skills.map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`),
    ].join("\n");
  }

  if (forcedSkills.length > 0) {
    section += [
      "\n\n## Active skills",
      `The user asked for these skills on this request; follow them without calling loadSkill. ${SKILL_RULE}`,
      ...forcedSkills.map(formatSkill),
    ].join("\n");
  }

  return section;
}
