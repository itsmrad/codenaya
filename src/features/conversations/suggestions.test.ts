import { describe, expect, it } from "vitest";

import { parseSuggestion, splitSuggestions } from "./suggestions";

describe("splitSuggestions", () => {
  it("takes the prompts out of the reply", () => {
    expect(
      splitSuggestions("- Built a todo app.\n\n<suggestions>\nAdd dark mode\n- Save todos\n</suggestions>"),
    ).toEqual({ content: "- Built a todo app.", suggestions: ["Add dark mode", "Save todos"] });
  });

  it("keeps at most 4 short, plain prompts", () => {
    const long = "x".repeat(101);
    const { suggestions } = splitSuggestions(
      `Done.\n<suggestions>\n1. "One"\n\n${long}\n2) Two\n* Three\n\`Four\`\nFive\n</suggestions>`,
    );
    expect(suggestions).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("keeps a repeated prompt once", () => {
    expect(splitSuggestions("Done.\n<suggestions>\nAdd dark mode\n- Add dark mode\nAdd a footer\n</suggestions>").suggestions)
      .toEqual(["Add dark mode", "Add a footer"]);
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

describe("parseSuggestion", () => {
  it("maps action tags to IDE actions and keeps the rest as prompts", () => {
    expect(parseSuggestion("[connect:stripe] Connect Stripe to take payments")).toEqual({
      label: "Connect Stripe to take payments",
      action: { kind: "connect", providerId: "stripe" },
    });
    expect(parseSuggestion("[Publish] Publish your site")).toEqual({ label: "Publish your site", action: { kind: "publish" } });
    expect(parseSuggestion("[env-vars] Set the form's destination email")).toEqual({
      label: "Set the form's destination email",
      action: { kind: "env-vars" },
    });
    expect(parseSuggestion("Add a gallery page")).toEqual({ label: "Add a gallery page", action: null });
  });

  it("treats an unknown or empty tag as plain text", () => {
    expect(parseSuggestion("[deploy] Ship it")).toEqual({ label: "[deploy] Ship it", action: null });
    expect(parseSuggestion("[publish]")).toEqual({ label: "[publish]", action: null });
  });

  it("parses the chips out of a reply in the new template", () => {
    const reply =
      "**What I built**\n- A pizzeria site, running in the preview.\n\n<suggestions>\n[connect:supabase] Save reservations in Supabase\n[publish] Publish the site\nAdd my real menu prices\n</suggestions>";
    expect(splitSuggestions(reply).suggestions.map((line) => parseSuggestion(line).action?.kind ?? "prompt")).toEqual([
      "connect",
      "publish",
      "prompt",
    ]);
  });
});
