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
  });

  it("returns a saved prompt once, then clears it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    savePendingPrompt("  A portfolio site  ");

    expect(storage.getItem(PENDING_PROMPT_KEY)).toBe("  A portfolio site  ");
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
});
