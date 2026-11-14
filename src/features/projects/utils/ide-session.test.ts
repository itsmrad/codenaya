import { afterEach, describe, expect, it, vi } from "vitest";

import { ideSessionKey, loadIdeSession, restorableTabs, saveIdeSession } from "./ide-session";

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

describe("IDE session (#315)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a project's view and tabs, separately per project", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    saveIdeSession("project_a", { view: "preview", openTabs: ["f1", "f2"], activeTabId: "f2" });

    expect(loadIdeSession("project_a")).toEqual({ view: "preview", openTabs: ["f1", "f2"], activeTabId: "f2" });
    expect(loadIdeSession("project_b")).toBeNull();
  });

  it("ignores data it didn't write", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    for (const raw of ["not json", '{"view":"settings","openTabs":[]}', '{"view":"editor"}']) {
      storage.setItem(ideSessionKey("p"), raw);
      expect(loadIdeSession("p")).toBeNull();
    }
    storage.setItem(ideSessionKey("p"), '{"view":"editor","openTabs":["f1",3],"activeTabId":7}');
    expect(loadIdeSession("p")).toEqual({ view: "editor", openTabs: ["f1"], activeTabId: null });
  });

  it("does nothing, and loads nothing, when storage is unavailable", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => saveIdeSession("p", { view: "chat", openTabs: [], activeTabId: null })).not.toThrow();
    expect(loadIdeSession("p")).toBeNull();
  });

  it("drops tabs whose files were deleted, and moves the active tab off one", () => {
    const session = { view: "editor" as const, openTabs: ["f1", "gone", "f3"], activeTabId: "gone" };
    expect(restorableTabs(session, new Set(["f1", "f3"]))).toEqual({ openTabs: ["f1", "f3"], activeTabId: "f3" });
    expect(restorableTabs({ ...session, activeTabId: "f1" }, new Set(["f1", "f3"]))).toEqual({
      openTabs: ["f1", "f3"],
      activeTabId: "f1",
    });
    expect(restorableTabs(session, new Set())).toEqual({ openTabs: [], activeTabId: null });
  });
});
