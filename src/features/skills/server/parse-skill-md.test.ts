import { describe, expect, it } from "vitest";

import { parseSkillMd } from "./parse-skill-md";

describe("parseSkillMd", () => {
  it("reads name, description and body", () => {
    const result = parseSkillMd(
      "---\nname: seo-metadata\ndescription: Add SEO metadata.\n---\n\n# SEO\n\nUse the metadata API.\n",
      "ignored",
    );

    expect(result).toEqual({
      ok: true,
      skill: {
        name: "seo-metadata",
        description: "Add SEO metadata.",
        body: "# SEO\n\nUse the metadata API.",
      },
    });
  });

  it("joins folded and literal YAML strings", () => {
    const result = parseSkillMd(
      [
        "---",
        "name: folded",
        "description: >",
        "  Use when the user asks",
        "  for a landing page.",
        "metadata:",
        "  license: MIT",
        "---",
        "Body",
      ].join("\r\n"),
      "folded",
    );

    expect(result).toMatchObject({
      ok: true,
      skill: { description: "Use when the user asks for a landing page.", body: "Body" },
    });
  });

  it("falls back to the folder name when name is missing", () => {
    const result = parseSkillMd("---\ndescription: Does things.\n---\nBody", "My-Skill");

    expect(result).toMatchObject({ ok: true, skill: { name: "my-skill" } });
  });

  it("rejects a file without frontmatter", () => {
    expect(parseSkillMd("# Just markdown", "x")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/frontmatter/),
    });
  });

  it("rejects invalid YAML", () => {
    expect(parseSkillMd("---\nname: [unclosed\n---\nBody", "x")).toEqual({
      ok: false,
      error: "SKILL.md frontmatter is not valid YAML",
    });
  });

  it("validates against the skill limits", () => {
    expect(parseSkillMd("---\nname: Bad--Name\ndescription: d\n---\n", "x")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Skill name/),
    });
    expect(parseSkillMd("---\nname: no-description\n---\nBody", "x")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/description/),
    });
    expect(
      parseSkillMd(`---\nname: long\ndescription: d\n---\n${"b".repeat(20_001)}`, "x"),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/20,000/) });
  });
});
