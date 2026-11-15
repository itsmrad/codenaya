import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeViewFor,
  cacheWorkspaceMode,
  loadCachedWorkspaceMode,
  resolveWorkspaceMode,
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

  it("uses the device copy while loading or when the read fails", () => {
    expect(resolveWorkspaceMode("chat", "ide", true)).toBe("chat");
    expect(resolveWorkspaceMode(undefined, "chat", undefined)).toBe("chat");
    // A backend without the query yet must not take the page down.
    expect(resolveWorkspaceMode(new Error("Could not find public function"), "ide", true)).toBe("ide");
  });

  it("shows the agent board with chat and preview, and opens hidden views on it (#525)", () => {
    expect(visibleViews("board", false)).toEqual(["board", "preview"]);
    expect(visibleViews("board", true)).toEqual(["chat", "board", "preview"]);
    expect(activeViewFor("chat", "board", false)).toBe("board");
    expect(activeViewFor("editor", "board", true)).toBe("board");
    expect(activeViewFor("preview", "board", false)).toBe("preview");
    // A saved board view in another mode opens on the preview.
    expect(activeViewFor("board", "ide", false)).toBe("preview");
  });

  it("falls back from board to the IDE once swarm reads off or fails, with no error (#525)", () => {
    expect(resolveWorkspaceMode("board", "ide", true)).toBe("board");
    expect(resolveWorkspaceMode("board", "ide", false)).toBe("ide");
    expect(resolveWorkspaceMode("board", "ide", new Error("no swarm"))).toBe("ide");
    // Still loading: keep the board rather than flash the IDE.
    expect(resolveWorkspaceMode(undefined, "board", undefined)).toBe("board");
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
    cacheWorkspaceMode("board");
    expect(loadCachedWorkspaceMode()).toBe("board");

    vi.stubGlobal("localStorage", undefined);
    expect(loadCachedWorkspaceMode()).toBe("ide");
  });
});
