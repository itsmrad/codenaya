import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_TEMPLATE_KEY,
  savePendingTemplate,
  takePendingTemplate,
} from "./pending-template";

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

describe("pending template", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a saved template once, then clears it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    savePendingTemplate("portfolio");

    expect(storage.getItem(PENDING_TEMPLATE_KEY)).toBe("portfolio");
    expect(takePendingTemplate()?.title).toBe("Portfolio");
    expect(takePendingTemplate()).toBeNull();
  });

  it("ignores an unknown template id", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    savePendingTemplate("not-a-template");

    expect(takePendingTemplate()).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });

    expect(() => savePendingTemplate("blog")).not.toThrow();
    expect(takePendingTemplate()).toBeNull();
  });
});
