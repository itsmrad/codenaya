import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { detectCredential } from "@/features/integrations/credential-guard";

import { ALL_BUILTIN_SKILLS, BUILTIN_SKILLS, visibleBuiltinSkills } from "./builtin";
import { BUILTIN_SKILL_NAMES } from "./builtin/names";
import { validateSkill } from "./limits";

describe("built-in skills", () => {
  it("match the reserved name list", () => {
    expect(ALL_BUILTIN_SKILLS.map((skill) => skill.name)).toEqual(BUILTIN_SKILL_NAMES);
  });

  it("list every skill but stripe-checkout until a payment provider is chosen", () => {
    const names = BUILTIN_SKILLS.map((skill) => skill.name);
    expect(names).not.toContain("stripe-checkout");
    expect(names).toEqual(BUILTIN_SKILL_NAMES.filter((name) => name !== "stripe-checkout"));
    // The skill itself still exists, and keeps its reserved name.
    expect(ALL_BUILTIN_SKILLS.map((skill) => skill.name)).toContain("stripe-checkout");
    expect(BUILTIN_SKILL_NAMES).toContain("stripe-checkout");
  });

  it("list stripe-checkout again when the hidden list is emptied", () => {
    expect(visibleBuiltinSkills([])).toEqual(ALL_BUILTIN_SKILLS);
  });

  it.each(ALL_BUILTIN_SKILLS.map((skill) => [skill.name, skill] as const))(
    "%s passes the skill limits",
    (_name, skill) => {
      expect(validateSkill(skill)).toBeNull();
    },
  );

  it.each(ALL_BUILTIN_SKILLS.map((skill) => [skill.name, skill] as const))(
    "%s contains no credential-shaped values",
    (_name, skill) => {
      expect(detectCredential(skill.body).matchedRules).toEqual([]);
    },
  );

  it("find-skills keeps its source and license attribution", () => {
    const source = readFileSync(
      new URL("./builtin/find-skills.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "https://github.com/vercel-labs/skills/blob/48dc9e8eb8aa19040e91cb90ba0b642c9cbad57e/skills/find-skills/SKILL.md",
    );
    expect(source).toContain("License: MIT");
    expect(source).toContain("Copyright (c) 2026 Vercel, Inc.");
  });

  it("find-skills does not tell the agent to run commands", () => {
    const [findSkills] = BUILTIN_SKILLS;

    expect(findSkills.body).not.toMatch(/npx|skills (find|add|init)/);
    expect(findSkills.body).toContain("Settings → Skills");
  });

  const bodyOf = (name: string) =>
    ALL_BUILTIN_SKILLS.find((skill) => skill.name === name)?.body ?? "";

  it("supabase-auth-db keeps RLS on and the secret key out of the app", () => {
    const body = bodyOf("supabase-auth-db");

    expect(body).toContain("NEVER disable RLS");
    expect(body).toContain("enable row level security");
    expect(body).toContain("(select auth.uid()) = user_id");
    expect(body).toMatch(/NEVER put the \*\*secret key\*\*[\s\S]*service_role/);
    expect(body).not.toMatch(/VITE_\w*(SECRET|SERVICE)/);
    expect(body).not.toMatch(/disable row level security|using \(true\)\s*;/i);
  });

  it("stripe-checkout keeps secrets server-side and verifies webhooks", () => {
    const body = bodyOf("stripe-checkout");

    expect(body).toContain("stripe.webhooks.constructEvent");
    expect(body).toContain("await req.text()");
    expect(body).toContain('import "server-only"');
    expect(body).toContain("process.env.STRIPE_SECRET_KEY");
    // Built lazily, so a missing key fails the request with a clear error, not `next build`.
    expect(body).toContain("export function getStripe(): Stripe | null");
    expect(body).not.toMatch(/export const stripe = new Stripe/);
    expect(body).toContain("Stripe isn't set up");
    expect(body).toContain("it removes the claim and rethrows");
    expect(body).not.toMatch(/(VITE|NEXT_PUBLIC)_STRIPE_(SECRET|WEBHOOK)/);
  });

  it("seo-and-share-cards covers share cards, robots and the sitemap", () => {
    const body = bodyOf("seo-and-share-cards");

    for (const tag of ["og:title", "og:image", "twitter:card", "summary_large_image"]) {
      expect(body).toContain(tag);
    }
    expect(body).toContain("public/robots.txt");
    expect(body).toContain("public/sitemap.xml");
    expect(body).toContain("never invent a domain");
    // Per-route values replace the index.html ones instead of adding duplicate tags.
    expect(body).toContain("export function usePageMeta");
    expect(body).not.toContain('<link rel="canonical" href=');
    expect(body).toContain('openGraph: { url: "/pricing", images: OG_IMAGES }');
    expect(body).not.toMatch(/<meta name="description"[^\n]*\/>\n\s*\{\/\* page content/);
  });
});
