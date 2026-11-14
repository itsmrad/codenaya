import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_PROMPT_KEY,
  peekPendingPrompt,
  savePendingPrompt,
  takePendingPrompt,
} from "./pending-prompt";

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
};

describe("pending prompt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns a saved prompt once, then clears it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    savePendingPrompt("  A portfolio site  ");

    expect(JSON.parse(storage.getItem(PENDING_PROMPT_KEY)!)).toEqual({
      prompt: "  A portfolio site  ", savedAt: expect.any(Number),
    });
    expect(takePendingPrompt()).toBe("A portfolio site");
    expect(takePendingPrompt()).toBeNull();
  });

  it("treats a blank prompt as nothing to resume", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    savePendingPrompt("   ");

    expect(takePendingPrompt()).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
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

    expect(() => savePendingPrompt("todo app")).not.toThrow();
    expect(takePendingPrompt()).toBeNull();
  });

  // #252: the auth pages show the prompt without consuming it.
  it("peeks at the prompt without clearing it, so the dashboard still gets it", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(peekPendingPrompt()).toBeNull();

    savePendingPrompt("  A habit tracker  ");
    expect(peekPendingPrompt()).toBe("A habit tracker");
    expect(peekPendingPrompt()).toBe("A habit tracker");
    expect(takePendingPrompt()).toBe("A habit tracker");
    expect(peekPendingPrompt()).toBeNull();
  });

  it("peeks at nothing when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(peekPendingPrompt()).toBeNull();
  });
  it("expires a saved prompt after one hour, including a non-consuming read", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    savePendingPrompt("A portfolio site");
    vi.advanceTimersByTime(3_599_999);
    expect(peekPendingPrompt()).toBe("A portfolio site");
    vi.advanceTimersByTime(2);
    expect(peekPendingPrompt()).toBeNull();
    expect(storage.getItem(PENDING_PROMPT_KEY)).toBeNull();
    expect(takePendingPrompt()).toBeNull();
  });

  it("reads a legacy bare string once", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(PENDING_PROMPT_KEY, "A portfolio site");
    expect(peekPendingPrompt()).toBe("A portfolio site");
    expect(takePendingPrompt()).toBe("A portfolio site");
    expect(takePendingPrompt()).toBeNull();
  });

  it.each([
    '{"prompt": 12, "savedAt": 0}',
    '{"prompt": "A portfolio site"}',
    '{"prompt": "A portfolio site", "savedAt": "yesterday"}',
  ])("discards invalid timestamped data: %s", (entry) => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(PENDING_PROMPT_KEY, entry);
    expect(peekPendingPrompt()).toBeNull();
    expect(storage.getItem(PENDING_PROMPT_KEY)).toBeNull();
  });

});
