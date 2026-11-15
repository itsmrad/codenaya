import { describe, expect, it } from "vitest";

import { formatProjectsBuilt, supportedProviders } from "./trust-signals";

describe("trust signals (#246)", () => {
  it("derives distinct provider names in catalog order, including new providers", () => {
    expect(supportedProviders([
      { provider: "First" }, { provider: "First" },
      { provider: "Second" }, { provider: "New provider" },
    ])).toEqual(["First", "Second", "New provider"]);
    expect(supportedProviders([])).toEqual([]);
  });

  it.each([
    [undefined, null],
    [null, null],
    [0, null],
    [1, "1 project built"],
    [1234, "1,234 projects built"],
  ])("formats %s projects as %s", (count, expected) => {
    expect(formatProjectsBuilt(count)).toBe(expected);
  });
});
