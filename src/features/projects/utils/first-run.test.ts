import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissFirstRun,
  getFirstRunProgress,
  hasOpenedPreview,
  isFirstRunDismissed,
  isPreviewOnScreen,
  markPreviewOpened,
} from "./first-run";

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

describe("first-run flags", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers that a preview was opened", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    expect(hasOpenedPreview()).toBe(false);
    markPreviewOpened();
    expect(hasOpenedPreview()).toBe(true);
  });

  it("keeps dismissal per user", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    dismissFirstRun("user_a");

    expect(isFirstRunDismissed("user_a")).toBe(true);
    expect(isFirstRunDismissed("user_b")).toBe(false);
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });

    expect(() => markPreviewOpened()).not.toThrow();
    expect(() => dismissFirstRun("user_a")).not.toThrow();
    expect(hasOpenedPreview()).toBe(false);
    expect(isFirstRunDismissed("user_a")).toBe(false);
  });
});

describe("getFirstRunProgress", () => {
  const empty = {
    projects: [],
    published: [],
    aiKeyCount: 0,
    skillCount: 0,
    githubConnected: false,
    previewOpened: false,
  };

  it("starts with every step open for a new user", () => {
    expect(Object.values(getFirstRunProgress(empty))).toEqual([false, false, false, false, false]);
  });

  it("marks the first step done once a project exists", () => {
    expect(getFirstRunProgress({ ...empty, projects: [{}] }).createProject).toBe(true);
  });

  it("accepts either an AI key or a skill", () => {
    expect(getFirstRunProgress({ ...empty, aiKeyCount: 1 }).addKeyOrSkill).toBe(true);
    expect(getFirstRunProgress({ ...empty, skillCount: 1 }).addKeyOrSkill).toBe(true);
  });

  it("counts a live showcase entry or a finished GitHub export as shipped", () => {
    expect(getFirstRunProgress({ ...empty, published: [{ status: "removed" }] }).ship).toBe(false);
    expect(getFirstRunProgress({ ...empty, published: [{ status: "published" }] }).ship).toBe(true);
    expect(
      getFirstRunProgress({ ...empty, projects: [{ exportStatus: "failed" }] }).ship,
    ).toBe(false);
    expect(
      getFirstRunProgress({ ...empty, projects: [{ exportStatus: "completed" }] }).ship,
    ).toBe(true);
  });
});

describe("isPreviewOnScreen", () => {
  const shown: Parameters<typeof isPreviewOnScreen>[0] = {
    visible: true,
    building: false,
    status: "running",
    error: null,
    loaded: true,
  };

  it("needs an open tab, a running preview with no error, no build card, and a load", () => {
    expect(isPreviewOnScreen(shown)).toBe(true);
    expect(isPreviewOnScreen({ ...shown, visible: false })).toBe(false);
    expect(isPreviewOnScreen({ ...shown, building: true })).toBe(false);
    expect(isPreviewOnScreen({ ...shown, status: "installing" })).toBe(false);
    expect(isPreviewOnScreen({ ...shown, loaded: false })).toBe(false);
  });

  it("waits out a stream error over a preview that loaded while hidden", () => {
    // Loaded behind the Code tab: not on screen yet.
    let preview = { ...shown, visible: false };
    expect(isPreviewOnScreen(preview)).toBe(false);
    // The stream fails but keeps its URL, so the earlier load still matches.
    preview = { ...preview, status: "error", error: "Preview failed to start" };
    // Opening Preview shows the error panel, not the app.
    preview = { ...preview, visible: true };
    expect(isPreviewOnScreen(preview)).toBe(false);
    // Restart: a new boot whose iframe has not loaded yet, then its load.
    preview = { ...preview, status: "running", error: null, loaded: false };
    expect(isPreviewOnScreen(preview)).toBe(false);
    expect(isPreviewOnScreen({ ...preview, loaded: true })).toBe(true);
  });
});
