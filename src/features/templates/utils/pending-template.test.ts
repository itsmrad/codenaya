import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_TEMPLATE_KEY,
  peekPendingTemplate,
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
    vi.useRealTimers();
  });

  it("returns a saved template once, then clears it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    savePendingTemplate("portfolio");

    expect(JSON.parse(storage.getItem(PENDING_TEMPLATE_KEY)!)).toEqual({ value: "portfolio", savedAt: expect.any(Number) });
    expect(takePendingTemplate()?.title).toBe("Portfolio");
    expect(takePendingTemplate()).toBeNull();
  });

  it("keeps the chosen framework in the envelope and returns it once", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    savePendingTemplate("blog", "next");
    expect(JSON.parse(localStorage.getItem(PENDING_TEMPLATE_KEY)!)).toEqual({ value: "blog", savedAt: expect.any(Number), framework: "next" });
    expect(takePendingTemplate()?.framework).toBe("next");
    expect(takePendingTemplate()).toBeNull();
  });

  it("ignores a framework picked before the selector was removed", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    localStorage.setItem("codenaya:projectFramework", "next");
    savePendingTemplate("blog");
    expect(JSON.parse(localStorage.getItem(PENDING_TEMPLATE_KEY)!)).toEqual({ value: "blog", savedAt: expect.any(Number) });
    expect(takePendingTemplate()?.framework).toBeUndefined();
  });

  it("drops a template older than an hour, including after peeking", () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", memoryStorage());
    savePendingTemplate("blog");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(peekPendingTemplate()?.id).toBe("blog");
    vi.advanceTimersByTime(1);
    expect(takePendingTemplate()).toBeNull();
    expect(localStorage.getItem(PENDING_TEMPLATE_KEY)).toBeNull();
  });

  it("reads a legacy template once", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    localStorage.setItem(PENDING_TEMPLATE_KEY, "blog");
    expect(peekPendingTemplate()?.id).toBe("blog");
    expect(takePendingTemplate()?.id).toBe("blog");
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

  it("peeks at the template without clearing it (#252)", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    savePendingTemplate("landing-page");
    expect(peekPendingTemplate()?.title).toBe("Landing page");
    expect(takePendingTemplate()?.id).toBe("landing-page");
    expect(peekPendingTemplate()).toBeNull();
  });
});
