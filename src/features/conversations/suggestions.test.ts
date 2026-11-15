import { describe, expect, it } from "vitest";

import { splitSuggestions } from "./suggestions";

describe("splitSuggestions", () => {
  it("takes the prompts out of the reply", () => {
    expect(
      splitSuggestions("- Built a todo app.\n\n<suggestions>\nAdd dark mode\n- Save todos\n</suggestions>"),
    ).toEqual({ content: "- Built a todo app.", suggestions: ["Add dark mode", "Save todos"] });
  });

  it("keeps at most 3 short, plain prompts", () => {
    const long = "x".repeat(101);
    const { suggestions } = splitSuggestions(
      `Done.\n<suggestions>\n1. "One"\n\n${long}\n2) Two\n* Three\n\`Four\`\n</suggestions>`,
    );
    expect(suggestions).toEqual(["One", "Two", "Three"]);
  });

  it("hides a malformed block", () => {
    expect(splitSuggestions("Done.\n<suggestions>\nAdd a footer")).toEqual({
      content: "Done.",
      suggestions: ["Add a footer"],
    });
    expect(splitSuggestions("Done.</suggestions>")).toEqual({ content: "Done.", suggestions: [] });
    expect(splitSuggestions("Done.\n<SUGGESTIONS></SUGGESTIONS>")).toEqual({
      content: "Done.",
      suggestions: [],
    });
  });

  it("leaves a reply without a block alone", () => {
    expect(splitSuggestions("- Built it.")).toEqual({ content: "- Built it.", suggestions: [] });
  });
});
