import { describe, expect, it } from "vitest";

import { dictationErrorMessage, insertTranscript, isDictationKey } from "./dictation";

describe("insertTranscript (#301)", () => {
  it("appends to typed text with a space, keeping what was typed", () => {
    expect(insertTranscript("Make the header", " sticky ", 15)).toEqual({
      value: "Make the header sticky",
      caret: 22,
    });
  });

  it("inserts at the cursor and replaces a selection", () => {
    expect(insertTranscript("Add a button", "blue", 6)).toEqual({ value: "Add a blue button", caret: 11 });
    expect(insertTranscript("Add a red button", "blue", 6, 9)).toEqual({
      value: "Add a blue button",
      caret: 10,
    });
  });

  it("fills an empty box and ignores empty results", () => {
    expect(insertTranscript("", "Build a todo app", 0)).toEqual({ value: "Build a todo app", caret: 16 });
    expect(insertTranscript("Keep", "  ", 4)).toEqual({ value: "Keep", caret: 4 });
  });
});

describe("dictationErrorMessage", () => {
  it("explains each failure and stays quiet for our own cancel", () => {
    expect(dictationErrorMessage("not-allowed")).toMatch(/Microphone access is blocked/);
    expect(dictationErrorMessage("service-not-allowed")).toMatch(/Microphone access is blocked/);
    expect(dictationErrorMessage("no-speech")).toMatch(/No speech heard/);
    expect(dictationErrorMessage("audio-capture")).toMatch(/No microphone/);
    expect(dictationErrorMessage("network")).toMatch(/network/);
    expect(dictationErrorMessage("bad-grammar")).toMatch(/stopped unexpectedly/);
    expect(dictationErrorMessage("aborted")).toBeNull();
  });
});

describe("isDictationKey", () => {
  const key = (init: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; code: string; key?: string }) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });

  it("matches Alt+V by key position, so Option+V on macOS counts", () => {
    expect(isDictationKey(key({ altKey: true, code: "KeyV", key: "√" }))).toBe(true);
    expect(isDictationKey(key({ altKey: true, code: "KeyV", key: "v" }))).toBe(true);
  });

  it("ignores V alone and other modifiers", () => {
    expect(isDictationKey(key({ code: "KeyV", key: "v" }))).toBe(false);
    expect(isDictationKey(key({ altKey: true, ctrlKey: true, code: "KeyV" }))).toBe(false);
    expect(isDictationKey(key({ altKey: true, metaKey: true, code: "KeyV" }))).toBe(false);
  });
});
