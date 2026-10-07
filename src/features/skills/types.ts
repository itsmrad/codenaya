import type { SkillFields } from "./limits";

/** Where a skill comes from. Built-ins live in code, the rest in Convex. */
export type SkillSource = "builtin" | "user" | "github";

/** Library skills are shared across projects; project skills exist in one. */
export type SkillScope = "builtin" | "library" | "project";

/**
 * Identifies a skill in `projectSkillSettings`: `builtin:<name>` for code
 * skills, `user:<skills _id>` for stored ones.
 */
export type SkillKey = `builtin:${string}` | `user:${string}`;

export const builtinSkillKey = (name: string): SkillKey => `builtin:${name}`;
export const userSkillKey = (skillId: string): SkillKey => `user:${skillId}`;

export type BuiltinSkill = SkillFields;

/** Where a built-in skill was adapted from, shown in Settings → Skills. */
export interface BuiltinSkillAttribution {
  label: string;
  url: string;
  license: string;
}

/** A skill as listed for one project, without its body. */
export interface ProjectSkillSummary {
  key: SkillKey;
  name: string;
  description: string;
  source: SkillSource;
  scope: SkillScope;
  enabled: boolean;
}
