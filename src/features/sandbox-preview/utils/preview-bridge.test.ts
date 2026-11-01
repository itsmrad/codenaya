import { describe, expect, it } from "vitest";

import {
  PREVIEW_BRIDGE_SCRIPT,
  PREVIEW_MESSAGE_SOURCE,
  injectPreviewBridge,
  readPreviewMessage,
} from "./preview-bridge";

describe("injectPreviewBridge", () => {
  it("puts the script first in <head>", () => {
    expect(injectPreviewBridge('<html><head lang="en"><title>x</title></head></html>')).toBe(
      `<html><head lang="en">${PREVIEW_BRIDGE_SCRIPT}<title>x</title></head></html>`,
    );
  });

  it("falls back to <html>, then to the start of the document", () => {
    expect(injectPreviewBridge("<html><body></body></html>")).toBe(
      `<html>${PREVIEW_BRIDGE_SCRIPT}<body></body></html>`,
    );
    expect(injectPreviewBridge("<h1>Hi</h1>")).toBe(`${PREVIEW_BRIDGE_SCRIPT}<h1>Hi</h1>`);
  });

  it("injects only once", () => {
    const once = injectPreviewBridge("<head></head>");
    expect(injectPreviewBridge(once)).toBe(once);
  });
});

describe("readPreviewMessage", () => {
  const frame = {} as Window;
  const previewUrl = "https://4000-abc.e2b.app";
  const data = {
    source: PREVIEW_MESSAGE_SOURCE,
    version: 1,
    kind: "runtime",
    message: "x is not defined",
    stack: "ReferenceError: x is not defined\n    at App",
  };
  const event = { data, origin: "https://4000-abc.e2b.app", source: frame };

  it("accepts a runtime error from the preview iframe", () => {
    expect(readPreviewMessage(event, frame, previewUrl)).toEqual({
      kind: "runtime",
      message: data.message,
      stack: data.stack,
    });
  });

  it("ignores other windows and origins", () => {
    expect(readPreviewMessage({ ...event, source: {} as Window }, frame, previewUrl)).toBeNull();
    expect(readPreviewMessage({ ...event, source: null }, frame, previewUrl)).toBeNull();
    expect(readPreviewMessage({ ...event, origin: "https://evil.example" }, frame, previewUrl)).toBeNull();
    expect(readPreviewMessage(event, null, previewUrl)).toBeNull();
    expect(readPreviewMessage(event, frame, null)).toBeNull();
  });

  it("ignores malformed or foreign payloads", () => {
    for (const bad of [
      "x is not defined",
      { ...data, source: "other" },
      { ...data, version: 2 },
      { ...data, message: 42 },
      null,
    ]) {
      expect(readPreviewMessage({ ...event, data: bad }, frame, previewUrl)).toBeNull();
    }
  });

  it("truncates long text", () => {
    const long = "a".repeat(10_000);
    const error = readPreviewMessage({ ...event, data: { ...data, message: long, stack: long } }, frame, previewUrl);
    expect(error?.message).toHaveLength(2048);
    expect(error?.stack).toHaveLength(2048);
  });
});
