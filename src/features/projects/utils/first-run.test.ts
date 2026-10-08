import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissFirstRun,
  getFirstRunProgress,
  hasOpenedPreview,
  isFirstRunDismissed,
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
