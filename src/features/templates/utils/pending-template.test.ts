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

    expect(JSON.parse(storage.getItem(PENDING_TEMPLATE_KEY)!)).toEqual({
      templateId: "portfolio", savedAt: expect.any(Number),
    });
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

  it("peeks at the template without clearing it (#252)", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    savePendingTemplate("landing-page");
    expect(peekPendingTemplate()?.title).toBe("Landing page");
    expect(takePendingTemplate()?.id).toBe("landing-page");
    expect(peekPendingTemplate()).toBeNull();
  });
  it("expires a saved template after one hour, including a non-consuming read", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    savePendingTemplate("portfolio");
    vi.advanceTimersByTime(3_599_999);
    expect(peekPendingTemplate()?.id).toBe("portfolio");
    vi.advanceTimersByTime(2);
    expect(peekPendingTemplate()).toBeNull();
    expect(storage.getItem(PENDING_TEMPLATE_KEY)).toBeNull();
    expect(takePendingTemplate()).toBeNull();
  });

  it("reads a legacy bare string once", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(PENDING_TEMPLATE_KEY, "portfolio");
    expect(peekPendingTemplate()?.id).toBe("portfolio");
    expect(takePendingTemplate()?.id).toBe("portfolio");
    expect(takePendingTemplate()).toBeNull();
  });

  it.each([
    '{"templateId": 12, "savedAt": 0}',
    '{"templateId": "portfolio"}',
    '{"templateId": "portfolio", "savedAt": "yesterday"}',
  ])("discards invalid timestamped data: %s", (entry) => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem(PENDING_TEMPLATE_KEY, entry);
    expect(peekPendingTemplate()).toBeNull();
    expect(storage.getItem(PENDING_TEMPLATE_KEY)).toBeNull();
  });

});
