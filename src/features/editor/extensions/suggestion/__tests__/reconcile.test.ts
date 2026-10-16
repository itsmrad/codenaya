import { describe, expect, it } from "vitest";
import { reconcileSuggestion } from "../reconcile";

describe("reconcileSuggestion", () => {
  it("returns empty string when suggestion is empty", () => {
    expect(reconcileSuggestion("", ")")).toEqual({
      insert: "",
      replaceLength: 0,
    });
  });

  describe("parentheses () auto-closing", () => {
    it("inserts missing ')' before '{' when auto-closed ')' is after cursor", () => {
      const result = reconcileSuggestion("a: number, b: number {", ")");
      expect(result).toEqual({
        insert: "a: number, b: number) {",
        replaceLength: 1,
      });
    });

    it("inserts missing ')' before '=>' when auto-closed ')' is after cursor", () => {
      const result = reconcileSuggestion("x, y =>", ")");
      expect(result).toEqual({
        insert: "x, y) =>",
        replaceLength: 1,
      });
    });

    it("spans auto-closed ')' when suggestion already contains ')'", () => {
      const result = reconcileSuggestion("a: number, b: number) {", ")");
      expect(result).toEqual({
        insert: "a: number, b: number) {",
        replaceLength: 1,
      });
    });

    it("keeps ')' intact when suggestion only fills arguments inside parentheses", () => {
      const result = reconcileSuggestion("a: number, b: number", ")");
      expect(result).toEqual({
        insert: "a: number, b: number",
        replaceLength: 0,
      });
    });
  });

  describe("brackets [] auto-closing", () => {
    it("inserts missing ']' before ';' when auto-closed ']' is after cursor", () => {
      const result = reconcileSuggestion("1, 2, 3;", "]");
      expect(result).toEqual({
        insert: "1, 2, 3];",
        replaceLength: 1,
      });
    });

    it("spans auto-closed ']' when suggestion already contains ']'", () => {
      const result = reconcileSuggestion("1, 2, 3];", "]");
      expect(result).toEqual({
        insert: "1, 2, 3];",
        replaceLength: 1,
      });
    });
  });

  describe("braces {} auto-closing", () => {
    it("inserts missing '}' before ';' when auto-closed '}' is after cursor", () => {
      const result = reconcileSuggestion('name: "test";', "}");
      expect(result).toEqual({
        insert: 'name: "test"};',
        replaceLength: 1,
      });
    });

    it("spans auto-closed '}' when suggestion already contains '}'", () => {
      const result = reconcileSuggestion('name: "test"};', "}");
      expect(result).toEqual({
        insert: 'name: "test"};',
        replaceLength: 1,
      });
    });
  });

  describe("quotes auto-closing", () => {
    it('handles double quotes "', () => {
      const result = reconcileSuggestion("hello world;", '"');
      expect(result).toEqual({
        insert: 'hello world";',
        replaceLength: 1,
      });

      const spanned = reconcileSuggestion('hello world";', '"');
      expect(spanned).toEqual({
        insert: 'hello world";',
        replaceLength: 1,
      });
    });

    it("handles single quotes '", () => {
      const result = reconcileSuggestion("hello world;", "'");
      expect(result).toEqual({
        insert: "hello world';",
        replaceLength: 1,
      });

      const spanned = reconcileSuggestion("hello world';", "'");
      expect(spanned).toEqual({
        insert: "hello world';",
        replaceLength: 1,
      });
    });

    it("handles template literals `", () => {
      const result = reconcileSuggestion("hello world;", "`");
      expect(result).toEqual({
        insert: "hello world`;",
        replaceLength: 1,
      });

      const spanned = reconcileSuggestion("hello world`;", "`");
      expect(spanned).toEqual({
        insert: "hello world`;",
        replaceLength: 1,
      });
    });
  });
});
