import { describe, expect, it } from "vitest";

import { createLoadSkillTool } from "./load-skill";

const skills = [
  { name: "find-skills", description: "Find skills", body: "# Find", source: "builtin" as const },
  { name: "seo-metadata", description: "SEO", body: "# SEO rules", source: "user" as const },
];

const load = (name: string, available = skills) =>
  createLoadSkillTool({ skills: available }).handler({ name }, {} as never);

describe("loadSkill tool", () => {
  it("returns the skill's full body", async () => {
    expect(await load("seo-metadata")).toBe(
      '<skill name="seo-metadata" source="user">\n# SEO rules\n</skill>',
    );
  });

  it("lists the valid names for an unknown skill", async () => {
    expect(await load("seo")).toBe(
      'Error: Unknown skill "seo". Available skills: find-skills, seo-metadata',
    );
  });
});
