import { afterEach, describe, expect, it, vi } from "vitest";

import { PENDING_INTENT_KEY } from "@/lib/pending-intent";

import { savePendingRemix, takePendingRemix } from "./pending-remix";

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

describe("pending remix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores a remix intent and returns its source path once", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    savePendingRemix("/showcase/abc123");

    expect(JSON.parse(storage.getItem(PENDING_INTENT_KEY)!)).toEqual({
      kind: "remix",
      source: "/showcase/abc123",
    });
    expect(takePendingRemix()).toBe("/showcase/abc123");
    expect(takePendingRemix()).toBeNull();
  });

  it("ignores malformed or foreign intents", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    storage.setItem(PENDING_INTENT_KEY, "not json");
    expect(takePendingRemix()).toBeNull();

    storage.setItem(PENDING_INTENT_KEY, JSON.stringify({ kind: "other" }));
    expect(takePendingRemix()).toBeNull();
  });

  it("is a no-op when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });

    expect(() => savePendingRemix("abc123")).not.toThrow();
    expect(takePendingRemix()).toBeNull();
  });
});
