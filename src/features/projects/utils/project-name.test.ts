import { describe, expect, test } from "vitest";

import {
  PROJECT_NAME_MAX_LENGTH,
  copyProjectName,
  projectNameFromTitle,
  validateProjectName,
} from "./project-name";

describe("validateProjectName", () => {
  test("accepts a normal name", () => {
    expect(validateProjectName("My app")).toBeNull();
  });

  test("rejects empty and over-long names", () => {
    expect(validateProjectName("")).toMatch(/empty/);
    expect(validateProjectName("a".repeat(PROJECT_NAME_MAX_LENGTH + 1))).toMatch(/at most/);
  });
});

describe("copyProjectName", () => {
  test("appends (copy)", () => {
    expect(copyProjectName("Todo app")).toBe("Todo app (copy)");
  });

  test("stays within the length limit", () => {
    const copy = copyProjectName("a".repeat(PROJECT_NAME_MAX_LENGTH));
    expect(copy.endsWith(" (copy)")).toBe(true);
    expect(validateProjectName(copy)).toBeNull();
  });
});

describe("projectNameFromTitle (#288)", () => {
  test.each([
    ["Tip Calculator UI Design", "Tip Calculator UI Design"],
    ['  "Habit   Tracker"  ', "Habit Tracker"],
    ["\u201cRecipe Box\u201d.", "Recipe Box"],
    ["Weather Dashboard!", "Weather Dashboard"],
  ])("cleans %j to %j", (title, name) => {
    expect(projectNameFromTitle(title)).toBe(name);
  });

  test("returns null when nothing is left", () => {
    expect(projectNameFromTitle('  "" . ')).toBeNull();
  });

  test("cuts an over-long title on a word boundary and stays valid", () => {
    const name = projectNameFromTitle(`${"word ".repeat(30)}end`)!;
    expect(name.length).toBeLessThanOrEqual(PROJECT_NAME_MAX_LENGTH);
    expect(name.endsWith("word")).toBe(true);
    expect(validateProjectName(name)).toBeNull();
  });
});
