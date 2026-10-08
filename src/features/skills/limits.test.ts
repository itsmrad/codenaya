import { describe, expect, it } from "vitest";

import {
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  validateSkill,
  validateSkillName,
} from "./limits";

const valid = { name: "seo-metadata", description: "Adds SEO tags.", body: "# Steps" };

describe("validateSkillName", () => {
  it.each(["a", "seo-metadata", "v2-api", "a".repeat(64)])("accepts %s", (name) => {
    expect(validateSkillName(name)).toBeNull();
  });

  it.each([
    "",
    "a".repeat(65),
    "Bad-Name",
    "bad--name",
    "-bad",
    "bad-",
    "bad_name",
    "bad name",
  ])("rejects %j", (name) => {
    expect(validateSkillName(name)).not.toBeNull();
  });
});

describe("validateSkill", () => {
  it("accepts a skill at every limit", () => {
    expect(
      validateSkill({
        name: "a".repeat(64),
        description: "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH),
        body: "b".repeat(SKILL_BODY_MAX_LENGTH),
      }),
    ).toBeNull();
  });

  it("rejects a blank or oversized description", () => {
    expect(validateSkill({ ...valid, description: "  " })).not.toBeNull();
    expect(
      validateSkill({ ...valid, description: "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1) }),
    ).not.toBeNull();
  });

  it("rejects a body over 20,000 characters", () => {
    expect(
      validateSkill({ ...valid, body: "b".repeat(SKILL_BODY_MAX_LENGTH + 1) }),
    ).toMatch(/20,000/);
  });
});
