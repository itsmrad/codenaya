import { describe, expect, it } from "vitest";
import { isSkillDraftDirty } from "./skill-draft";

const initial = { name: "seo", description: "SEO tags", body: "# Steps", scope: "library" as const };

describe("skill draft dirtiness", () => {
  it("keeps untouched and reverted drafts clean", () => {
    expect(isSkillDraftDirty(initial, { ...initial })).toBe(false);
    const edited = { ...initial, body: "New instructions" };
    expect(isSkillDraftDirty(initial, { ...edited, body: initial.body })).toBe(false);
  });
  it.each([
    { name: "seo-copy" }, { description: "New description" },
    { body: "New instructions" }, { scope: "project" as const },
  ])("detects edits to %j", (change) => {
    expect(isSkillDraftDirty(initial, { ...initial, ...change })).toBe(true);
  });
});
