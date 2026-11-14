import type { BuiltinSkill, BuiltinSkillAttribution } from "../types";
import { findSkills, findSkillsAttribution } from "./find-skills";
import { reactPerformance } from "./react-performance";
import { seoAndShareCards } from "./seo-and-share-cards";
import { stripeCheckout } from "./stripe-checkout";
import { supabaseAuthDb } from "./supabase-auth-db";

/** Every built-in skill, in index order. Names must match `names.ts`. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  findSkills,
  reactPerformance,
  supabaseAuthDb,
  seoAndShareCards,
  stripeCheckout,
];

/** Source and license of each built-in skill, by name. */
export const BUILTIN_SKILL_ATTRIBUTIONS: Readonly<
  Record<string, BuiltinSkillAttribution>
> = { [findSkills.name]: findSkillsAttribution };
