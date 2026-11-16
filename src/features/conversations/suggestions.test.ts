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

  it("drops chips that name a hidden provider", () => {
    const reply =
      "Done.\n<suggestions>\n[connect:stripe] Connect Stripe to take payments\nSet up STRIPE checkout\n[connect:supabase] Save orders in Supabase\nAdd a payment step\n</suggestions>";
    expect(splitSuggestions(reply).suggestions).toEqual(["[connect:supabase] Save orders in Supabase", "Add a payment step"]);
    expect(JSON.stringify(splitSuggestions(reply))).not.toMatch(/stripe/i);
    // Emptying the hidden list keeps them again.
    expect(splitSuggestions(reply, []).suggestions).toHaveLength(4);
  });

  it("never shows an action tag written in the reply body (#859)", () => {
    const reply =
      "**Recommended next steps**\n- [connect:supabase] Connect Supabase to save entries\n- [publish]\n- Then [env-vars] set the email\n- Read [publish](https://example.com/docs)\n\n<suggestions>\n[publish] Publish the site\n</suggestions>";
    expect(splitSuggestions(reply)).toEqual({
      content:
        "**Recommended next steps**\n- Connect Supabase to save entries\n- Then set the email\n- Read [publish](https://example.com/docs)",
      suggestions: ["[publish] Publish the site"],
    });
  });

  it("reads a tag with odd spacing or case, and gives a bare tag no chip", () => {
    const { suggestions } = splitSuggestions(
      "Done.\n<suggestions>\n[connect: Supabase] Save entries\n[ Publish ] Go live\n[publish]\nAdd a footer\n</suggestions>",
    );
    expect(suggestions.map((line) => parseSuggestion(line))).toEqual([
      { label: "Save entries", action: { kind: "connect", providerId: "supabase" } },
      { label: "Go live", action: { kind: "publish" } },
      { label: "Add a footer", action: null },
    ]);
  });

  it("hides a block wrapped in a code fence, closed or cut off", () => {
    expect(splitSuggestions("Done.\n\n```\n<suggestions>\n[publish] Publish\n</suggestions>\n```")).toEqual({
      content: "Done.",
      suggestions: ["[publish] Publish"],
    });
    expect(splitSuggestions("Done.\n\n```text\n<suggestions>\n[publish] Publish\n```")).toEqual({
      content: "Done.",
      suggestions: ["[publish] Publish"],
    });
    expect(splitSuggestions("Done.\n<suggestions>\n[publish] Publish\n[connect:resend] Send em")).toEqual({
      content: "Done.",
      suggestions: ["[publish] Publish", "[connect:resend] Send em"],
    });
  });

  it("leaves action-looking text in code alone (#859 review)", () => {
    expect(splitSuggestions("Use `[publish]` in the config").content).toBe("Use `[publish]` in the config");
    expect(splitSuggestions("const x = [connect: true]").content).toBe("const x = [connect: true]");
    expect(splitSuggestions("```md\n- [publish]\n- [connect:supabase] Save\n```\n- [publish] Go live").content).toBe(
      "```md\n- [publish]\n- [connect:supabase] Save\n```\n- Go live",
    );
  });

  it("keeps an unrelated code fence next to the block", () => {
    const before = "```js\nconst a = 1;\n```\n<suggestions>\n[publish] Publish\n</suggestions>";
    expect(splitSuggestions(before)).toEqual({ content: "```js\nconst a = 1;\n```", suggestions: ["[publish] Publish"] });
    const after = "Done.\n<suggestions>\n[publish] Publish\n</suggestions>\n```js\nconst b = 2;\n```";
    expect(splitSuggestions(after)).toEqual({ content: "Done.\n\n```js\nconst b = 2;\n```", suggestions: ["[publish] Publish"] });
  });

  it("leaves a reply without a block alone", () => {
    expect(splitSuggestions("- Built it.")).toEqual({ content: "- Built it.", suggestions: [] });
  });
});

describe("parseSuggestion", () => {
  it("maps action tags to IDE actions and keeps the rest as prompts", () => {
    expect(parseSuggestion("[connect:resend] Connect Resend to send emails")).toEqual({
      label: "Connect Resend to send emails",
      action: { kind: "connect", providerId: "resend" },
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
    // Vercel is deliberately not in the catalog; "constructor" is a prototype key.
    expect(parseSuggestion("[connect:vercel] Connect Vercel")).toEqual({ label: "Connect Vercel", action: null });
    expect(parseSuggestion("[connect:constructor] Connect it")).toEqual({ label: "Connect it", action: null });
    // Stripe is hidden until a payment provider is chosen.
    expect(parseSuggestion("[connect:stripe] Take payments")).toEqual({ label: "Take payments", action: null });
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
