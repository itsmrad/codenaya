import { describe, expect, it } from "vitest";

import {
  capNotesForPrompt,
  looksLikeLastingPreference,
  MAX_PROMPT_NOTES,
  MAX_PROMPT_NOTES_CHARS,
} from "./notes";

const note = (text: string, createdAt: number) => ({ id: `n${createdAt}`, text, createdAt });

describe("capNotesForPrompt", () => {
  it("keeps notes oldest first and skips blank ones", () => {
    expect(capNotesForPrompt([note("b", 2), note(" ", 3), note("a", 1)])).toEqual(["a", "b"]);
    expect(capNotesForPrompt()).toEqual([]);
  });

  it("drops the oldest beyond the note count", () => {
    const notes = Array.from({ length: MAX_PROMPT_NOTES + 5 }, (_, i) => note(`n${i}`, i));
    const kept = capNotesForPrompt(notes);
    expect(kept).toHaveLength(MAX_PROMPT_NOTES);
    expect(kept[0]).toBe("n5");
    expect(kept.at(-1)).toBe(`n${MAX_PROMPT_NOTES + 4}`);
  });

  it("drops the oldest beyond the character budget", () => {
    const big = "x".repeat(MAX_PROMPT_NOTES_CHARS / 2);
    expect(capNotesForPrompt([note(`old${big}`, 1), note(big, 2), note(big, 3)])).toEqual([big, big]);
  });
});

describe("looksLikeLastingPreference", () => {
  it.each(["Prices are in EUR", "Don't use purple", "Keep the header sticky", "Never change the logo"])(
    "proposes %s",
    (text) => expect(looksLikeLastingPreference(text)).toBe(true),
  );

  it.each(["Add a contact page", "/skill do it", "ok", `Always ${"x".repeat(400)}`, "Keep this.\n\nAnd add more."])(
    "does not propose %s",
    (text) => expect(looksLikeLastingPreference(text)).toBe(false),
  );
});
