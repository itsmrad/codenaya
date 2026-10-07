import { describe, expect, test } from "vitest";

import {
  PROJECT_NAME_MAX_LENGTH,
  copyProjectName,
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
