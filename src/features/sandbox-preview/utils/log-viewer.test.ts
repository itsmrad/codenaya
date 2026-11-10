import { describe, expect, it } from "vitest";
import {
  sliceClearedOutput,
  shouldResetClearedOffset,
  normalizeBufferText,
} from "./log-viewer";

describe("log-viewer", () => {
  describe("sliceClearedOutput", () => {
    it("returns full output when clearedOffset is 0", () => {
      expect(sliceClearedOutput("hello world", 0)).toBe("hello world");
    });

    it("returns empty string when cleared at the current output end", () => {
      expect(sliceClearedOutput("hello world", 11)).toBe("");
    });

    it("returns only new output appended after clear", () => {
      expect(sliceClearedOutput("hello world, new logs", 11)).toBe(", new logs");
    });

    it("resets and returns full output when output restarts from a shorter length", () => {
      expect(sliceClearedOutput("restarted logs", 50)).toBe("restarted logs");
    });
  });

  describe("shouldResetClearedOffset", () => {
    it("returns true when current output length is less than cleared offset (restart)", () => {
      expect(shouldResetClearedOffset(10, 50)).toBe(true);
    });

    it("returns false when output is longer than or equal to cleared offset", () => {
      expect(shouldResetClearedOffset(50, 50)).toBe(false);
      expect(shouldResetClearedOffset(60, 50)).toBe(false);
    });

    it("returns false when offset is 0", () => {
      expect(shouldResetClearedOffset(0, 0)).toBe(false);
    });
  });

  describe("normalizeBufferText", () => {
    it("joins lines with newline and trims trailing blank lines", () => {
      expect(normalizeBufferText(["line 1", "line 2", "", "   "])).toBe("line 1\nline 2");
    });

    it("preserves empty lines between content", () => {
      expect(normalizeBufferText(["line 1", "", "line 2"])).toBe("line 1\n\nline 2");
    });

    it("handles empty arrays", () => {
      expect(normalizeBufferText([])).toBe("");
    });
  });
});
