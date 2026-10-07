import { describe, expect, it } from "vitest";

import { buildSkillsPromptSection, formatSkill } from "./prompt";
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
});

describe("formatSkill", () => {
  it("wraps the body with the skill's name and source", () => {
    expect(formatSkill(seo)).toBe(
      '<skill name="seo-metadata" source="user">\n# SEO\nSECRET_BODY_MARKER\n</skill>',
    );
  });
});
