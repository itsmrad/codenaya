import type { BuiltinSkill } from "../types";
import { findSkills } from "./find-skills";

/** Every built-in skill, in index order. Names must match `names.ts`. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [findSkills];
