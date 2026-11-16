import { expect, test } from "vitest";
import { previewDeadline, safePreviewPath, validShareToken } from "./preview-policy";

test("idle deadlines and keep-live windows", () => {
  expect(previewDeadline(1000)).toBe(601000);
  expect(previewDeadline(1000, 900000)).toBe(900000);
  expect(previewDeadline(1000, 500)).toBe(601000);
});
test("validates opaque slugs and rejects traversal and dependency paths", () => {
  expect(validShareToken("a".repeat(32))).toBe(true);
  for (const token of ["../secret", "a".repeat(31), "G".repeat(32)]) expect(validShareToken(token)).toBe(false);
  for (const path of ["/etc/passwd", "../x", "src/../x", "src\\x", "node_modules/x", ".git/config"]) expect(safePreviewPath(path)).toBe(false);
  expect(safePreviewPath("src/app.tsx")).toBe(true);
});
