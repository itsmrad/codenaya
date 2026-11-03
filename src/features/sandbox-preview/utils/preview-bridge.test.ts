import { describe, expect, it, vi } from "vitest";

import {
  PREVIEW_BRIDGE_SCRIPT,
  PREVIEW_MESSAGE_SOURCE,
  installPreviewBridge,
  injectPreviewBridge,
  insertBridge,
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

  it("works from its source alone, the way the E2B proxy runs it", () => {
    // route.ts writes `const insertBridge = ${String(insertBridge)};` into the proxy.
    const fromSource = new Function(`return (${String(insertBridge)});`)() as typeof insertBridge;
    for (const html of [
      '<html><head lang="en"><title>x</title></head></html>',
      "<html><body></body></html>",
      "<h1>Hi</h1>",
      injectPreviewBridge("<head></head>"),
    ]) {
      expect(fromSource(html, PREVIEW_BRIDGE_SCRIPT)).toBe(injectPreviewBridge(html));
    }
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

describe("installPreviewBridge", () => {
  // Run from its source, the way the injected <script> runs it.
  const install = new Function(`return (${String(installPreviewBridge)});`)() as typeof installPreviewBridge;

  const setup = () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const posted: Array<{ message: string; stack?: string }> = [];
    const original = vi.fn();
    const win = {
      parent: { postMessage: (message: { message: string; stack?: string }) => posted.push(message) },
      addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      console: { error: original },
    };
    install(win as unknown as typeof window, PREVIEW_MESSAGE_SOURCE, 1, 2048);
    return { win, listeners, posted, original };
  };
  // React 19's dev log for an error an error boundary caught (#335).
  const boundaryLog = (error: unknown) => [
    "%o\n\n%s\n\n%s\n",
    error,
    "The above error occurred in the <App> component.",
    "React will try to recreate this component tree from scratch using the error boundary you provided, ErrorBoundary.",
  ];

  it("reports a boundary-caught error once and still logs it", () => {
    const { win, posted, original } = setup();
    const error = new Error("Render exploded");

    win.console.error(...boundaryLog(error));
    expect(original).toHaveBeenCalledWith(...boundaryLog(error));
    expect(posted).toEqual([
      expect.objectContaining({ source: PREVIEW_MESSAGE_SOURCE, kind: "runtime", message: "Render exploded" }),
    ]);

    // A repeated log, or the same error from window, isn't posted again.
    win.console.error(...boundaryLog(error));
    expect(posted).toHaveLength(1);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("dedupes window error and a log of the same error", () => {
    const { win, listeners, posted } = setup();
    const error = new Error("Boom");

    listeners.error({ error, message: "Uncaught Error: Boom" });
    win.console.error(...boundaryLog(error));
    expect(posted).toHaveLength(1);
  });

  it("leaves an app's own handled console.error alone", () => {
    const { win, posted, original } = setup();

    win.console.error(new Error("fetch failed"));
    win.console.error("Could not load", new Error("fetch failed"));
    expect(posted).toHaveLength(0);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("never throws on a hostile error object, and still logs", () => {
    const { win, listeners, posted, original } = setup();
    const hostile = Object.create(Error.prototype, {
      message: { get: () => { throw new Error("getter"); } },
    });
    const prototypeTrap = new Proxy({}, {
      getPrototypeOf: () => { throw new Error("trap"); },
    });

    expect(() => win.console.error(...boundaryLog(hostile))).not.toThrow();
    expect(() => win.console.error(...boundaryLog(prototypeTrap))).not.toThrow();
    expect(() => listeners.unhandledrejection({ reason: hostile })).not.toThrow();
    expect(original).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(0);
  });

  it("reports uncaught errors and rejections", () => {
    const { listeners, posted } = setup();

    listeners.error({ error: new Error("Uncaught one"), message: "x" });
    listeners.unhandledrejection({ reason: "plain reason" });
    expect(posted.map((message) => message.message)).toEqual(["Uncaught one", "plain reason"]);
  });

  it("does nothing outside an iframe", () => {
    const original = vi.fn();
    const win = { addEventListener: vi.fn(), console: { error: original } } as unknown as typeof window;
    (win as { parent: unknown }).parent = win;
    install(win, PREVIEW_MESSAGE_SOURCE, 1, 2048);
    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(win.console.error).toBe(original);
  });

  it("is what the injected script runs", () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(String(installPreviewBridge));
  });
});
