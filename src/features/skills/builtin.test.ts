import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BUILTIN_SKILLS } from "./builtin";
import { BUILTIN_SKILL_NAMES } from "./builtin/names";
import { validateSkill } from "./limits";

describe("built-in skills", () => {
  it("match the reserved name list", () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual(BUILTIN_SKILL_NAMES);
  });

  it.each(BUILTIN_SKILLS.map((skill) => [skill.name, skill] as const))(
    "%s passes the skill limits",
    (_name, skill) => {
      expect(validateSkill(skill)).toBeNull();
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
});
