import { describe, expect, it, vi } from "vitest";

import type { AppError } from "./app-error";
import {
  PREVIEW_BRIDGE_SCRIPT,
  PREVIEW_MESSAGE_SOURCE,
  installPreviewBridge,
  injectPreviewBridge,
  insertBridge,
  previewTargetOrigin,
  readPreviewMessage,
  routePreviewMessage,
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

describe("previewTargetOrigin", () => {
  it("returns the origin of an http(s) URL, port included", () => {
    expect(previewTargetOrigin("https://4000-abc.e2b.app/x?y=1")).toBe("https://4000-abc.e2b.app");
    expect(previewTargetOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
  });

  it("is null for URLs with no usable origin", () => {
    for (const url of ["about:blank", "blob:https://a.example/id", "data:text/html,hi", "not a url", "", null, undefined]) {
      expect(previewTargetOrigin(url)).toBeNull();
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
    expect(readPreviewMessage({ ...event, origin: "null" }, frame, "about:blank")).toBeNull();
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

  it("accepts a build error from Vite's overlay", () => {
    const build = {
      source: PREVIEW_MESSAGE_SOURCE,
      version: 1,
      kind: "build",
      message: "[plugin:vite:react-babel] Unexpected token (3:4)",
      file: "/home/user/app/src/App.tsx:3:4",
    };
    expect(readPreviewMessage({ ...event, data: build }, frame, previewUrl)).toEqual({
      kind: "build",
      message: build.message,
      file: "src/App.tsx",
      line: 3,
    });
    expect(
      readPreviewMessage({ ...event, data: { ...build, kind: "other" } }, frame, previewUrl),
    ).toBeNull();
  });

  it("reads a new page from the preview iframe only (#486)", () => {
    const page = { source: PREVIEW_MESSAGE_SOURCE, version: 1, kind: "page", message: "" };
    expect(readPreviewMessage({ ...event, data: page }, frame, previewUrl)).toEqual({ kind: "page" });
    // Another window or origin can't clear the preview's errors.
    expect(readPreviewMessage({ ...event, data: page, source: {} as Window }, frame, previewUrl)).toBeNull();
    expect(readPreviewMessage({ ...event, data: page, origin: "https://evil.example" }, frame, previewUrl)).toBeNull();
    expect(readPreviewMessage({ ...event, data: { ...page, source: "other" } }, frame, previewUrl)).toBeNull();
  });

  const element = {
    tag: "button", id: "save", classes: ["primary"], text: "Save",
    outerHTML: "<button>Save</button>", domPath: "body > button", siblingText: "Form",
    rect: { x: 1, y: 2, width: 30, height: 40 },
  };
  const picked = { source: PREVIEW_MESSAGE_SOURCE, version: 1, kind: "select:picked", element };

  it("accepts picks only from the preview source and origin", () => {
    const pickEvent = { ...event, data: picked };
    expect(readPreviewMessage(pickEvent, frame, previewUrl)).toEqual({ kind: "select:picked", element });
    expect(readPreviewMessage({ ...pickEvent, source: {} as Window }, frame, previewUrl)).toBeNull();
    expect(readPreviewMessage({ ...pickEvent, origin: "https://other.example" }, frame, previewUrl)).toBeNull();
  });

  it("refuses every oversized pick field and non-finite rects", () => {
    const invalid = [
      { tag: "x".repeat(65) }, { id: "x".repeat(129) },
      { text: "x".repeat(201) }, { outerHTML: "x".repeat(2049) },
      { domPath: "x".repeat(513) }, { siblingText: "x".repeat(301) },
      { classes: Array(21).fill("x") }, { classes: ["x".repeat(65)] },
      ...["x", "y", "width", "height"].flatMap((field) =>
        [Infinity, -Infinity, NaN].map((value) => ({ rect: { ...element.rect, [field]: value } }))),
    ];
    for (const fields of invalid) {
      expect(readPreviewMessage({ ...event, data: { ...picked, element: { ...element, ...fields } } }, frame, previewUrl)).toBeNull();
    }
  });

  it("routes select:picked without setting or clearing a runtime error", () => {
    const setRuntimeError = vi.fn();
    const onPick = vi.fn();
    const onOff = vi.fn();
    routePreviewMessage(readPreviewMessage({ ...event, data: picked }, frame, previewUrl), setRuntimeError, onPick, onOff);
    expect(onPick).toHaveBeenCalledWith(element);
    expect(setRuntimeError).not.toHaveBeenCalled();
    routePreviewMessage({ kind: "page" }, setRuntimeError, onPick, onOff);
    expect(setRuntimeError).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("truncates long text", () => {
    const long = "a".repeat(10_000);
    const error = readPreviewMessage({ ...event, data: { ...data, message: long, stack: long } }, frame, previewUrl) as AppError;
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
      setTimeout,
    };
    install(win as unknown as typeof window, PREVIEW_MESSAGE_SOURCE, 1, 2048);
    // The new-page signal; its own test covers it.
    posted.splice(0, 1);
    return { win, listeners, posted, original };
  };
  it("selects only on parent commands, suppresses navigation, and leaves on Esc", () => {
    const { win, listeners, posted } = setup();
    const remove = vi.fn();
    class ElementStub {
      tagName = "BUTTON";
      id = "save";
      classList = ["primary"];
      textContent = "Save";
      outerHTML = "<button>Save</button>";
      parentElement = null;
      getBoundingClientRect() { return { x: 1, y: 2, width: 30, height: 40 }; }
    }
    const style = {};
    Object.assign(win, {
      Element: ElementStub,
      document: { createElement: () => ({ style, remove }), documentElement: { appendChild: vi.fn() } },
    });
    const command = { source: win.parent, data: { source: PREVIEW_MESSAGE_SOURCE, version: 1, kind: "select:on" } };
    const click = { target: new ElementStub(), preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    listeners.message({ ...command, source: {} });
    listeners.click(click);
    expect(click.preventDefault).not.toHaveBeenCalled();
    listeners.message(command);
    listeners.mousemove(click);
    expect(style).toMatchObject({ width: "30px", height: "40px" });
    listeners.click(click);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(click.stopPropagation).toHaveBeenCalledOnce();
    expect(posted).toEqual([expect.objectContaining({ kind: "select:picked", element: expect.objectContaining({ text: "Save" }) })]);
    expect(remove).toHaveBeenCalledOnce();
    listeners.click(click);
    expect(posted).toHaveLength(1);
    listeners.message(command);
    listeners.keydown({ ...click, key: "Escape" });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ kind: "select:off" });
    listeners.click(click);
    expect(posted).toHaveLength(2);
  });

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

    // Within the same task a repeat isn't posted again.
    win.console.error(...boundaryLog(error));
    expect(posted).toHaveLength(1);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("reports the same error again after the tick, as after an edit that didn't fix it", async () => {
    const { win, listeners, posted } = setup();
    const error = new Error("Still broken");

    win.console.error(...boundaryLog(error));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // React Refresh retries the boundary and logs the identical error.
    win.console.error(...boundaryLog(error));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A stackless rejection repeated by a re-clicked handler.
    listeners.unhandledrejection({ reason: "no stack" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.unhandledrejection({ reason: "no stack" });

    expect(posted.map((message) => message.message)).toEqual([
      "Still broken",
      "Still broken",
      "no stack",
      "no stack",
    ]);
  });

  it("ignores the browser's ResizeObserver loop notices, but not Script error.", () => {
    const { listeners, posted } = setup();

    listeners.error({ error: null, message: "ResizeObserver loop completed with undelivered notifications." });
    listeners.error({ error: null, message: "ResizeObserver loop limit exceeded" });
    listeners.error({ error: null, message: "Script error." });
    expect(posted.map((message) => message.message)).toEqual(["Script error."]);
  });

  it("reports a thrown non-Error from the boundary log", () => {
    const { win, posted } = setup();

    win.console.error(...boundaryLog("boom"));
    expect(posted).toEqual([expect.objectContaining({ message: "boom" })]);
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

  it.each([
    "Hydration failed because the server rendered HTML didn't match the client.",
    "A tree hydrated but some attributes of the server rendered HTML didn't match the client properties.",
    "Text content does not match server-rendered HTML.",
  ])("reports hydration console errors without a boundary log: %s", (message) => {
    for (const value of [message, new Error(message)]) {
      const { win, posted, original } = setup();
      win.console.error(value);
      expect(posted).toEqual([expect.objectContaining({ kind: "runtime", message })]);
      expect(original).toHaveBeenCalledWith(value);
    }
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

  it("announces each new document before the app's scripts run (#486)", () => {
    const posted: unknown[] = [];
    const win = {
      parent: { postMessage: (message: unknown) => posted.push(message) },
      addEventListener: vi.fn(),
      console: { error: vi.fn() },
      setTimeout,
    };
    install(win as unknown as typeof window, PREVIEW_MESSAGE_SOURCE, 1, 2048);
    expect(posted).toEqual([{ source: PREVIEW_MESSAGE_SOURCE, version: 1, kind: "page", message: "" }]);
  });

  it("does nothing outside an iframe", () => {
    const original = vi.fn();
    const win = { addEventListener: vi.fn(), console: { error: original } } as unknown as typeof window;
    (win as { parent: unknown }).parent = win;
    install(win, PREVIEW_MESSAGE_SOURCE, 1, 2048);
    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(win.console.error).toBe(original);
  });

  describe("Vite's error overlay (#497)", () => {
    /** A Vite overlay element as `ErrorOverlay` builds it, open shadow root and all. */
    const overlay = (parts: Record<string, string>) => ({
      nodeName: "VITE-ERROR-OVERLAY",
      shadowRoot: {
        querySelector: (selector: string) =>
          selector in parts ? { textContent: parts[selector] } : null,
      },
    });
    const compileError = overlay({
      ".plugin": "[plugin:vite:import-analysis]",
      ".message-body": '  Failed to resolve import "./Missing" from "src/App.tsx".  ',
      ".file": "/home/user/app/src/App.tsx:2:19",
    });

    const setupDom = (readyState: string, existing: unknown = null) => {
      const posted: Array<Record<string, unknown>> = [];
      const documentListeners: Record<string, () => void> = {};
      const observers: Array<{ callback: (records: unknown[]) => void; target: unknown }> = [];
      const body = { querySelector: () => existing };
      const win = {
        parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
        addEventListener: vi.fn(),
        console: { error: vi.fn() },
        setTimeout,
        document: {
          readyState,
          body,
          addEventListener: (type: string, listener: () => void) => (documentListeners[type] = listener),
        },
        MutationObserver: class {
          constructor(readonly callback: (records: unknown[]) => void) {}
          observe(target: unknown) {
            observers.push({ callback: this.callback, target });
          }
        },
      };
      install(win as unknown as typeof window, PREVIEW_MESSAGE_SOURCE, 1, 2048);
      posted.splice(0, 1);
      const append = (...nodes: unknown[]) =>
        observers.forEach(({ callback }) => callback([{ addedNodes: nodes }]));
      return { posted, documentListeners, observers, body, append };
    };

    it("reports an overlay appended to <body> as a build error", () => {
      const { posted, observers, body, append } = setupDom("complete");

      expect(observers).toEqual([expect.objectContaining({ target: body })]);
      append({ nodeName: "DIV" }, compileError);

      expect(posted).toEqual([
        {
          source: PREVIEW_MESSAGE_SOURCE,
          version: 1,
          kind: "build",
          message: '[plugin:vite:import-analysis] Failed to resolve import "./Missing" from "src/App.tsx".',
          file: "/home/user/app/src/App.tsx:2:19",
        },
      ]);
    });

    it("waits for <body> while the page loads, then reads an overlay already there", () => {
      const { posted, observers, documentListeners } = setupDom("loading", compileError);

      expect(observers).toHaveLength(0);
      documentListeners.DOMContentLoaded();
      expect(observers).toHaveLength(1);
      expect(posted).toEqual([expect.objectContaining({ kind: "build" })]);
    });

    it("ignores an overlay without a message, and never throws on a broken one", () => {
      const { posted, append } = setupDom("complete");
      const broken = {
        nodeName: "VITE-ERROR-OVERLAY",
        shadowRoot: { querySelector: () => { throw new Error("detached"); } },
      };

      expect(() => append(overlay({ ".file": "src/App.tsx" }), broken, null)).not.toThrow();
      expect(posted).toHaveLength(0);
    });
  });

  it("is what the injected script runs", () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(String(installPreviewBridge));
  });
});
