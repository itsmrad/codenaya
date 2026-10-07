/**
 * Agent Skills limits (agentskills.io/specification), plus Codenaya's own caps.
 *
 * Plain TS with no imports so Convex mutations, the agent and the UI all
 * validate against the same rules.
 */

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_BODY_MAX_LENGTH = 20_000;

/** Library skills (no project) per user. */
export const MAX_LIBRARY_SKILLS = 50;
/** Skills that exist only in one project. */
export const MAX_PROJECT_SKILLS = 20;
/** Skills listed in the agent's per-run index. */
export const MAX_INDEXED_SKILLS = 40;

// Lowercase letters, digits and single hyphens between them.
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFields {
  name: string;
  description: string;
  body: string;
}

/** Returns why `name` is invalid, or null when it is valid. */
export function validateSkillName(name: string): string | null {
  if (name.length < 1 || name.length > SKILL_NAME_MAX_LENGTH) {
    return `Skill name must be 1-${SKILL_NAME_MAX_LENGTH} characters`;
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return "Skill name may only use lowercase letters, digits and single hyphens, and cannot start or end with a hyphen";
  }
  return null;
}

/** Returns the first reason the skill is invalid, or null when it is valid. */
export function validateSkill(skill: SkillFields): string | null {
  const nameError = validateSkillName(skill.name);
  if (nameError) return nameError;

  if (
    skill.description.trim().length === 0 ||
    skill.description.length > SKILL_DESCRIPTION_MAX_LENGTH
  ) {
    return `Skill description must be 1-${SKILL_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (skill.body.length > SKILL_BODY_MAX_LENGTH) {
    return `Skill body must be at most ${SKILL_BODY_MAX_LENGTH.toLocaleString("en-US")} characters`;
  }
  return null;
}
