import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeViewFor,
  cacheWorkspaceMode,
  loadCachedWorkspaceMode,
  visibleViews,
} from "./workspace-mode";

describe("workspace mode (#524)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps each mode to its visible tabs", () => {
    expect(visibleViews("ide", false)).toEqual(["editor", "preview"]);
    expect(visibleViews("ide", true)).toEqual(["chat", "editor", "preview"]);
    expect(visibleViews("chat", false)).toEqual(["preview"]);
    expect(visibleViews("chat", true)).toEqual(["chat", "preview"]);
  });

  it("opens a saved Code view on the preview in chat-first mode", () => {
    expect(activeViewFor("editor", "chat", false)).toBe("preview");
    expect(activeViewFor("editor", "chat", true)).toBe("preview");
    expect(activeViewFor("editor", "ide", false)).toBe("editor");
  });

  it("falls back from the chat to the first desktop tab", () => {
    expect(activeViewFor("chat", "ide", false)).toBe("editor");
    expect(activeViewFor("chat", "chat", false)).toBe("preview");
    expect(activeViewFor("chat", "chat", true)).toBe("chat");
  });

  it("caches the mode on the device and defaults to ide", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    expect(loadCachedWorkspaceMode()).toBe("ide");
    cacheWorkspaceMode("chat");
    expect(loadCachedWorkspaceMode()).toBe("chat");

    vi.stubGlobal("localStorage", undefined);
    expect(loadCachedWorkspaceMode()).toBe("ide");
  });
});
