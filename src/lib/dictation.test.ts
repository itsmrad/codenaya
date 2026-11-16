import { describe, expect, it } from "vitest";

import {
  DICTATION_AUTO,
  dictationErrorMessage,
  dictationRouteOrNull,
  insertTranscript,
  isDictationKey,
  isServerDictationLanguage,
  recorderErrorCode,
  transcribeErrorMessage,
} from "./dictation";

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

describe("dictationRouteOrNull", () => {
  const both = { canRecord: true, canRecognize: true };

  it("sends a language the server knows to the server, with a hint only when picked", () => {
    expect(dictationRouteOrNull({ ...both, picked: DICTATION_AUTO, browserLanguage: "pt-BR" })).toEqual({
      engine: "server",
    });
    expect(dictationRouteOrNull({ ...both, picked: "de", browserLanguage: "en-US" })).toEqual({
      engine: "server",
      language: "de",
    });
  });

  it("falls back to the browser for a language the server doesn't know", () => {
    expect(dictationRouteOrNull({ ...both, picked: DICTATION_AUTO, browserLanguage: "ja-JP" })).toEqual({
      engine: "browser",
      lang: "ja-JP",
    });
    expect(dictationRouteOrNull({ ...both, picked: "hi", browserLanguage: "en-US" })).toEqual({
      engine: "browser",
      lang: "hi",
    });
  });

  it("uses whichever engine exists, and null with neither", () => {
    expect(
      dictationRouteOrNull({ picked: "hi", browserLanguage: "en", canRecord: true, canRecognize: false }),
    ).toEqual({ engine: "server", language: "hi" });
    expect(
      dictationRouteOrNull({ picked: "de", browserLanguage: "en", canRecord: false, canRecognize: true }),
    ).toEqual({ engine: "browser", lang: "de" });
    expect(
      dictationRouteOrNull({ picked: DICTATION_AUTO, browserLanguage: "en", canRecord: false, canRecognize: false }),
    ).toBeNull();
  });
});

describe("transcription errors", () => {
  it("maps microphone failures to the speech recognition messages", () => {
    expect(dictationErrorMessage(recorderErrorCode(new DOMException("", "NotAllowedError")))).toMatch(
      /blocked/,
    );
    expect(dictationErrorMessage(recorderErrorCode({ name: "NotFoundError" }))).toBe("No microphone found.");
    expect(recorderErrorCode(null)).toBe("unknown");
  });

  it("says out of credits with the server's words, and fails plainly otherwise", () => {
    expect(transcribeErrorMessage(402, "You've used today's free credits.")).toBe(
      "You've used today's free credits.",
    );
    expect(transcribeErrorMessage(402)).toBe("Out of credits.");
    expect(transcribeErrorMessage(422, "Your OpenRouter key was refused for transcription.")).toBe(
      "Your OpenRouter key was refused for transcription.",
    );
    expect(transcribeErrorMessage(502)).toBe("Transcription failed, try again.");
  });
});

describe("isServerDictationLanguage", () => {
  it.each(["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it",
    "lt", "lv", "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk"])("keeps server routing for %s", (language) => {
    expect(isServerDictationLanguage(language)).toBe(true);
    expect(isServerDictationLanguage(`${language.toUpperCase()}-XX`)).toBe(true);
  });
  it.each(["ar", "hi", "id", "ja", "ko", "tr", "vi", "zh", ""])("uses browser routing for %s", (language) => {
    expect(isServerDictationLanguage(language)).toBe(false);
  });
});
