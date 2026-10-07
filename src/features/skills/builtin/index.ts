import type { BuiltinSkill, BuiltinSkillAttribution } from "../types";
import { findSkills, findSkillsAttribution } from "./find-skills";

/** Every built-in skill, in index order. Names must match `names.ts`. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [findSkills];

/** Source and license of each built-in skill, by name. */
export const BUILTIN_SKILL_ATTRIBUTIONS: Readonly<
  Record<string, BuiltinSkillAttribution>
> = { [findSkills.name]: findSkillsAttribution };
