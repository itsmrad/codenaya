import { HIDDEN_SKILLS_UNTIL_PAYMENT_PROVIDER_CHOSEN } from "../../integrations/hidden-until-payment-provider";
import type { BuiltinSkill, BuiltinSkillAttribution } from "../types";
import { findSkills, findSkillsAttribution } from "./find-skills";
import { reactPerformance } from "./react-performance";
import { seoAndShareCards } from "./seo-and-share-cards";
import { stripeCheckout } from "./stripe-checkout";
import { supabaseAuthDb } from "./supabase-auth-db";

/** Every built-in skill, hidden ones included, in index order. Names must match `names.ts`. */
export const ALL_BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  findSkills,
  reactPerformance,
  supabaseAuthDb,
  seoAndShareCards,
  stripeCheckout,
];

/** Built-in skills that are listed and offered (see `HIDDEN_SKILLS_UNTIL_PAYMENT_PROVIDER_CHOSEN`). */
export const visibleBuiltinSkills = (
  hidden: readonly string[] = HIDDEN_SKILLS_UNTIL_PAYMENT_PROVIDER_CHOSEN,
): readonly BuiltinSkill[] => ALL_BUILTIN_SKILLS.filter(({ name }) => !hidden.includes(name));

/** The built-in skills every list shows, in index order. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = visibleBuiltinSkills();

/** Source and license of each built-in skill, by name. */
export const BUILTIN_SKILL_ATTRIBUTIONS: Readonly<
  Record<string, BuiltinSkillAttribution>
> = { [findSkills.name]: findSkillsAttribution };
