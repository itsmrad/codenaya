import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_PROMPT_KEY,
  clearPendingPrompt,
  peekPendingPrompt,
  resumePendingPrompt,
  savePendingPrompt,
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
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it.each(["vite", "next", "tanstack-start"] as const)("keeps %s with the draft across a failed creation", async (framework) => {
    savePendingPrompt("A blog", "plan", framework);
    const create = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await resumePendingPrompt(create);
    await resumePendingPrompt(create);
    expect(create).toHaveBeenLastCalledWith({ prompt: "A blog", mode: "plan", framework });
  });

  it("ignores an invalid saved framework", async () => {
    localStorage.setItem(PENDING_PROMPT_KEY, JSON.stringify({ prompt: "A blog", framework: "unknown" }));
    const create = vi.fn().mockResolvedValue(true);
    await resumePendingPrompt(create);
    expect(create).toHaveBeenCalledWith({ prompt: "A blog" });
  });

  it("keeps the draft and mode on failure, then clears them on successful retry", async () => {
    savePendingPrompt(" A kanban board ", "swarm");
    const create = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await resumePendingPrompt(create)).toBe(false);
    expect(peekPendingPrompt()).toBe("A kanban board");
    expect(await resumePendingPrompt(create)).toBe(true);
    expect(create).toHaveBeenNthCalledWith(2, { prompt: "A kanban board", mode: "swarm" });
    expect(peekPendingPrompt()).toBeNull();
    expect(await resumePendingPrompt(create)).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps the draft on rejection and releases it for retry", async () => {
    savePendingPrompt("A portfolio site");
    expect(await resumePendingPrompt(vi.fn().mockRejectedValue(new Error("offline")))).toBe(false);
    expect(peekPendingPrompt()).toBe("A portfolio site");
    expect(await resumePendingPrompt(async () => true)).toBe(true);
    expect(peekPendingPrompt()).toBeNull();
  });

  it.each([true, false])("preserves a newer draft when creation returns %s", async (created) => {
    savePendingPrompt("Original draft", "plan");
    await resumePendingPrompt(async () => {
      savePendingPrompt("New draft", "swarm");
      return created;
    });
    expect(peekPendingPrompt()).toBe("New draft");
    const create = vi.fn().mockResolvedValue(true);
    await resumePendingPrompt(create);
    expect(create).toHaveBeenCalledWith({ prompt: "New draft", mode: "swarm" });
  });

  it("preserves a newly saved draft even when its text is identical", async () => {
    savePendingPrompt("Same draft");
    await resumePendingPrompt(async () => {
      savePendingPrompt("Same draft");
      return true;
    });
    expect(peekPendingPrompt()).toBe("Same draft");
  });

  it("ignores duplicate effect attempts while creation is pending", async () => {
    savePendingPrompt("A portfolio site");
    let finish!: (created: boolean) => void;
    const create = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const first = resumePendingPrompt(create);
    expect(peekPendingPrompt()).toBe("A portfolio site");
    expect(await resumePendingPrompt(create)).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await first).toBe(true);
    expect(await resumePendingPrompt(create)).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["  An old todo app ", { prompt: "An old todo app" }],
    ['{"title":"not a saved prompt"}', { prompt: '{"title":"not a saved prompt"}' }],
    ['{"prompt":"A shop","mode":"unknown"}', { prompt: "A shop" }],
    ['{"prompt":"A blog","mode":"plan"}', { prompt: "A blog", mode: "plan" }],
  ])("reads existing storage: %s", async (raw, pending) => {
    localStorage.setItem(PENDING_PROMPT_KEY, raw);
    const create = vi.fn().mockResolvedValue(true);
    await resumePendingPrompt(create);
    expect(create).toHaveBeenCalledWith(pending);
  });

  it("peeks without consuming and ignores blank drafts", async () => {
    savePendingPrompt(" A habit tracker ");
    expect(localStorage.getItem(PENDING_PROMPT_KEY)).toBe(" A habit tracker ");
    expect(peekPendingPrompt()).toBe("A habit tracker");
    expect(peekPendingPrompt()).toBe("A habit tracker");
    savePendingPrompt("   ");
    const create = vi.fn();
    expect(await resumePendingPrompt(create)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not throw when storage is unavailable", async () => {
    const blocked = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => savePendingPrompt("A todo app")).not.toThrow();
    expect(peekPendingPrompt()).toBeNull();
    expect(await resumePendingPrompt(vi.fn())).toBeNull();
  });

  it("clears the draft, and tolerates unavailable storage", () => {
    savePendingPrompt("A todo app");
    clearPendingPrompt();
    expect(peekPendingPrompt()).toBeNull();
    const blocked = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { removeItem: blocked });
    expect(() => clearPendingPrompt()).not.toThrow();
  });
});
