import { afterEach, describe, expect, it, vi } from "vitest";

import { readDashboardTab, writeDashboardTab } from "./dashboard-tab";

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
};

describe("dashboard tab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to projects and remembers the last pick", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    expect(readDashboardTab()).toBe("projects");
    writeDashboardTab("community");
    expect(readDashboardTab()).toBe("community");
  });

  it("ignores an unknown stored value", () => {
    const storage = memoryStorage();
    storage.setItem("codenaya:dashboardTab", "settings");
    vi.stubGlobal("localStorage", storage);

    expect(readDashboardTab()).toBe("projects");
  });

  it("falls back to projects when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });

    expect(() => writeDashboardTab("templates")).not.toThrow();
    expect(readDashboardTab()).toBe("projects");
  });
});
