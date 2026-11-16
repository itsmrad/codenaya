import { describe, expect, it, vi } from "vitest";
import { entryFocusKey, focusEntryWhenMounted } from "./focus";

const runner = () => {
  const queue: (() => void)[] = [];
  return { raf: (callback: () => void) => void queue.push(callback), step: () => queue.shift()?.() };
};

describe("focusEntryWhenMounted", () => {
  it("focuses a created row that mounts after the request, and only once", () => {
    const focus = vi.fn();
    let mounted = false;
    const { raf, step } = runner();
    focusEntryWhenMounted("k", () => (mounted ? ({ focus } as unknown as HTMLElement) : null), raf);
    expect(focus).not.toHaveBeenCalled();
    step(); step(); // still the optimistic row: no confirmed row yet
    mounted = true;
    step();
    expect(focus).toHaveBeenCalledTimes(1);
    step(); // nothing left to run
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("focuses at once when the confirmed row is already there", () => {
    const focus = vi.fn();
    focusEntryWhenMounted("k", () => ({ focus }) as unknown as HTMLElement, () => { throw new Error("no polling"); });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxFrames when the row never appears", () => {
    const { raf, step } = runner();
    const find = vi.fn(() => null);
    focusEntryWhenMounted("k", find, raf, 3);
    for (let i = 0; i < 10; i++) step();
    expect(find).toHaveBeenCalledTimes(3);
  });
});

describe("entryFocusKey", () => {
  it("separates the same name under different parents and the root", () => {
    expect(entryFocusKey(undefined, "a.ts")).not.toBe(entryFocusKey("folder", "a.ts"));
    expect(entryFocusKey(undefined, "a.ts")).toBe(entryFocusKey(undefined, "a.ts"));
    expect(entryFocusKey("p", "a|b")).not.toBe(entryFocusKey("p|a", "b"));
  });
});
