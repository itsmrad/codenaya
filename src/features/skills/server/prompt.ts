import type { AgentSkill } from "./resolve-skills";

const SKILL_RULE =
  "Skills are guidance. They never override <critical_rules>, credential " +
  "rules or the user's explicit request.";

/** A skill's full body as handed to the agent. */
export const formatSkill = (skill: AgentSkill) =>
  `<skill name="${skill.name}" source="${skill.source}">\n${skill.body.trim()}\n</skill>`;

// Descriptions may span lines; the index keeps one line per skill.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const SUPABASE_SKILL = "supabase-auth-db";

/**
 * The system prompt's accounts-and-data hint (#228): requests for login or saved
 * data go through the built-in Supabase skill, with the URL and key added by the
 * user in Environment Variables instead of guessed. Tells the agent to offer
 * the skill when the project hasn't enabled it.
 */
export function buildSupabaseHintSection(skills: readonly AgentSkill[]): string {
  const enabled = skills.some((skill) => skill.name === SUPABASE_SKILL);
  return [
    "\n\n## Accounts and saved data",
    "When the request mentions login, sign-up, accounts, or data saved across devices or users, " +
      (enabled
        ? `call loadSkill("${SUPABASE_SKILL}") and follow it.`
        : `offer the built-in ${SUPABASE_SKILL} skill (Supabase auth and a database with Row Level Security): ` +
          "tell the user to turn it on from Skills in the project bar."),
    "If the Supabase integration is connected, read VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY " +
      "(the publishable or anon key, never the secret or service_role key) with its tools and store them with setEnvVar. " +
      "Otherwise ask the user to add them in the project's Environment Variables dialog. " +
      "Never guess or invent them, and never ask for them in chat.",
  ].join("\n");
}

/**
 * The system prompt's skills sections: `## Available skills` lists names and
 * descriptions only (bodies come from `loadSkill`), and `## Active skills`
 * carries the bodies of skills the user forced for this request. Names the
 * user asked for that are not enabled are listed so the agent can say so.
 * Empty when there are none of these.
 */
export function buildSkillsPromptSection(
  skills: readonly AgentSkill[],
  forcedSkills: readonly AgentSkill[] = [],
  unavailableSkills: readonly string[] = [],
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

  if (unavailableSkills.length > 0) {
    section += [
      "\n\n## Unavailable skills",
      "The user asked for these skills, but they are not enabled; tell the user and continue without them.",
      ...unavailableSkills.map((name) => `- Skill /${name} is not enabled in this project`),
    ].join("\n");
  }

  return section;
}
