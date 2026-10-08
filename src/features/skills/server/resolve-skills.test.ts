import { describe, expect, it } from "vitest";

import { MAX_INDEXED_SKILLS } from "../limits";
import type { SkillScope } from "../types";
import {
  type ProjectSkill,
  resolveForcedSkills,
  resolveSkills,
} from "./resolve-skills";

const skill = (
  name: string,
  scope: SkillScope,
  updatedAt?: number,
  enabled = true,
): ProjectSkill => ({
  name,
  description: `Use for ${name}`,
  body: `# ${name}`,
  source: scope === "builtin" ? "builtin" : "user",
  scope,
  enabled,
  updatedAt,
});

describe("resolveSkills", () => {
  it("leaves out disabled skills", () => {
    expect(
      resolveSkills([
        skill("find-skills", "builtin", undefined, false),
        skill("alpha", "library", 1),
        skill("beta", "library", 2, false),
      ]).map((s) => s.name),
    ).toEqual(["alpha"]);
  });

  it("orders built-ins, then project skills, then the most recently updated library skills", () => {
    expect(
      resolveSkills([
        skill("old-lib", "library", 1),
        skill("new-lib", "library", 3),
        skill("local", "project", 2),
        skill("find-skills", "builtin"),
      ]).map((s) => s.name),
    ).toEqual(["find-skills", "local", "new-lib", "old-lib"]);
  });

  it(`caps the index at ${MAX_INDEXED_SKILLS}, dropping the oldest library skills`, () => {
    const library = Array.from({ length: 50 }, (_, i) =>
      skill(`lib-${i}`, "library", i),
    );
    const resolved = resolveSkills([...library, skill("local", "project", 0)]);

    expect(resolved).toHaveLength(MAX_INDEXED_SKILLS);
    expect(resolved[0].name).toBe("local");
    expect(resolved[1].name).toBe("lib-49");
    expect(resolved.map((s) => s.name)).not.toContain("lib-0");
  });

  it("keeps only what the agent needs", () => {
    expect(resolveSkills([skill("alpha", "library", 1)])).toEqual([
      { name: "alpha", description: "Use for alpha", body: "# alpha", source: "user" },
    ]);
  });
});

describe("resolveForcedSkills", () => {
  it("returns enabled skills with bodies and reports the rest", () => {
    const { forced, unavailable } = resolveForcedSkills(
      [skill("alpha", "library", 1), skill("beta", "library", 2, false)],
      ["alpha", "beta", "gamma"],
    );

    expect(forced).toEqual([
      { name: "alpha", description: "Use for alpha", body: "# alpha", source: "user" },
    ]);
    expect(unavailable).toEqual(["beta", "gamma"]);
  });

  it("can force an enabled skill left out of the capped index", () => {
    const library = Array.from({ length: 50 }, (_, i) =>
      skill(`lib-${i}`, "library", i),
    );

    expect(resolveForcedSkills(library, ["lib-0"]).forced.map((s) => s.name)).toEqual([
      "lib-0",
    ]);
  });
});
