import { describe, expect, it } from "vitest";

import { buildSkillsPromptSection, buildSupabaseHintSection, formatSkill } from "./prompt";
import type { AgentSkill } from "./resolve-skills";

const seo: AgentSkill = {
  name: "seo-metadata",
  description: "Use when adding SEO metadata\nor a sitemap",
  body: "# SEO\nSECRET_BODY_MARKER",
  source: "user",
};
const findSkills: AgentSkill = {
  name: "find-skills",
  description: "Helps users discover skills",
  body: "# Find skills",
  source: "builtin",
};

describe("buildSkillsPromptSection", () => {
  it("lists names and descriptions only, one line each", () => {
    const section = buildSkillsPromptSection([findSkills, seo]);

    expect(section).toContain("## Available skills");
    expect(section).toContain("call loadSkill(name) BEFORE writing files");
    expect(section).toContain("never override <critical_rules>");
    expect(section).toContain("- find-skills: Helps users discover skills\n");
    expect(section).toContain("- seo-metadata: Use when adding SEO metadata or a sitemap");
    expect(section).not.toContain("SECRET_BODY_MARKER");
    expect(section).not.toContain("## Active skills");
  });

  it("is empty when no skill is enabled", () => {
    expect(buildSkillsPromptSection([])).toBe("");
  });

  it("carries forced skills' bodies under Active skills", () => {
    const section = buildSkillsPromptSection([findSkills], [seo]);

    expect(section).toContain("## Active skills");
    expect(section).toContain(formatSkill(seo));
    expect(section.indexOf("## Available skills")).toBeLessThan(
      section.indexOf("## Active skills"),
    );
  });

  it("tells the agent which requested skills are not enabled", () => {
    const section = buildSkillsPromptSection([], [], ["stripe"]);

    expect(section).toContain("## Unavailable skills");
    expect(section).toContain("Skill /stripe is not enabled in this project");
    expect(section).not.toContain("## Available skills");
  });
});

describe("formatSkill", () => {
  it("wraps the body with the skill's name and source", () => {
    expect(formatSkill(seo)).toBe(
      '<skill name="seo-metadata" source="user">\n# SEO\nSECRET_BODY_MARKER\n</skill>',
    );
  });
});

describe("buildSupabaseHintSection (#228)", () => {
  const supabase: AgentSkill = {
    name: "supabase-auth-db",
    description: "Supabase auth and data",
    body: "# Supabase",
    source: "builtin",
  };

  it("offers the skill for login and saved data, with env vars from the dialog", () => {
    const section = buildSupabaseHintSection([findSkills]);

    expect(section).toContain("## Accounts and saved data");
    expect(section).toContain("login, sign-up, accounts, or data saved across devices or users");
    expect(section).not.toContain("saving data");
    expect(section).toContain("offer the built-in supabase-auth-db skill");
    expect(section).toContain("Otherwise ask the user to add them in the project's Environment Variables dialog");
    expect(section).toContain("Never guess or invent them");
    expect(section).not.toContain("loadSkill");
  });

  it("reads the values through a connected Supabase integration instead of asking", () => {
    const section = buildSupabaseHintSection([findSkills]);

    expect(section).toContain(
      "If the Supabase integration is connected, read VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY",
    );
    expect(section).toContain("with its tools and store them with setEnvVar");
  });

  it("loads the skill when the project has it enabled", () => {
    const section = buildSupabaseHintSection([supabase]);

    expect(section).toContain('call loadSkill("supabase-auth-db")');
    expect(section).not.toContain("offer the built-in");
  });
});
