import { MAX_INDEXED_SKILLS } from "../limits";
import type { SkillScope, SkillSource } from "../types";

/** A skill as the agent sees it: an index entry plus the body `loadSkill` returns. */
export interface AgentSkill {
  name: string;
  description: string;
  body: string;
  source: SkillSource;
}

/** A project skill as `system.getProjectSkills` returns it. */
export interface ProjectSkill extends AgentSkill {
  scope: SkillScope;
  enabled: boolean;
  /** Stored skills only; built-ins have none. */
  updatedAt?: number;
}

const SCOPE_ORDER: Record<SkillScope, number> = {
  builtin: 0,
  project: 1,
  library: 2,
};

const toAgentSkill = ({ name, description, body, source }: AgentSkill): AgentSkill => ({
  name,
  description,
  body,
  source,
});

/**
 * The skills for one agent run: enabled only, built-ins first, then project
 * skills, then library skills, most recently updated first within each, capped
 * at `MAX_INDEXED_SKILLS`.
 */
export function resolveSkills(skills: readonly ProjectSkill[]): AgentSkill[] {
  return skills
    .filter((skill) => skill.enabled)
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    )
    .slice(0, MAX_INDEXED_SKILLS)
    .map(toAgentSkill);
}

/**
 * The skills a message forced by name (see `parseSlashSkills`): enabled ones
 * are returned with their bodies, any other name is reported as unavailable.
 * Not capped by the index, so an enabled skill can always be forced.
 */
export function resolveForcedSkills(
  skills: readonly ProjectSkill[],
  names: readonly string[],
): { forced: AgentSkill[]; unavailable: string[] } {
  const forced: AgentSkill[] = [];
  const unavailable: string[] = [];
  for (const name of names) {
    const skill = skills.find((s) => s.enabled && s.name === name);
    if (skill) forced.push(toAgentSkill(skill));
    else unavailable.push(name);
  }
  return { forced, unavailable };
}
