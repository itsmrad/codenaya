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
    expect(takePendingPrompt()).toEqual({ prompt: "A portfolio site" });
    expect(takePendingPrompt()).toBeNull();
  });

  it("round-trips the mode, keeping a build prompt a plain string", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    savePendingPrompt(" A kanban board ", "swarm");
    expect(peekPendingPrompt()).toBe("A kanban board");
    expect(takePendingPrompt()).toEqual({ prompt: "A kanban board", mode: "swarm" });

    savePendingPrompt("A blog", "plan");
    expect(takePendingPrompt()).toEqual({ prompt: "A blog", mode: "plan" });

    savePendingPrompt("A blog");
    expect(storage.getItem(PENDING_PROMPT_KEY)).toBe("A blog");
  });

  it("still reads a plain prompt saved before modes, and JSON-looking prompts", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    storage.setItem(PENDING_PROMPT_KEY, "  An old todo app ");
    expect(takePendingPrompt()).toEqual({ prompt: "An old todo app" });

    storage.setItem(PENDING_PROMPT_KEY, '{"title": "not a saved prompt"}');
    expect(takePendingPrompt()).toEqual({ prompt: '{"title": "not a saved prompt"}' });

    storage.setItem(PENDING_PROMPT_KEY, JSON.stringify({ prompt: "A shop", mode: "hive" }));
    expect(takePendingPrompt()).toEqual({ prompt: "A shop" });
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
    expect(takePendingPrompt()).toEqual({ prompt: "A habit tracker" });
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
