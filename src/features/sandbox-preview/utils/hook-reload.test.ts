import { describe, expect, it } from "vitest";

import {
  HOOK_RELOAD_SETTLE_MS,
  MAX_HOOK_RELOADS,
  MIN_RELOAD_GAP_MS,
  hookReloadDelay,
  isHookError,
} from "./hook-reload";

const runtime = (message: string) => ({ kind: "runtime" as const, message });

describe("isHookError (#486)", () => {
  it.each([
    "Invalid hook call. Hooks can only be called inside of the body of a function component.",
    "Cannot read properties of null (reading 'useCallback')",
    "Cannot read properties of null (reading 'useState')",
    "Cannot read properties of null (reading 'useContext')",
  ])("matches %s", (message) => {
    expect(isHookError(runtime(message))).toBe(true);
  });

  it.each([
    "Cannot read properties of null (reading 'name')",
    "Cannot read properties of undefined (reading 'useCallback')",
    "x is not defined",
    "Rendered more hooks than during the previous render.",
  ])("leaves %s to the auto-fix", (message) => {
    expect(isHookError(runtime(message))).toBe(false);
  });

  it("ignores build errors and no error", () => {
    expect(isHookError({ kind: "build", message: "Invalid hook call" })).toBe(false);
    expect(isHookError(null)).toBe(false);
  });
});

describe("hookReloadDelay", () => {
  it("waits for Vite's own reload first", () => {
    expect(hookReloadDelay(0, 0, 60_000)).toBe(HOOK_RELOAD_SETTLE_MS);
  });

  it("holds off a reload that would follow another within the gap", () => {
    // The startup refresh or a first build's end reloaded 500 ms ago.
    expect(hookReloadDelay(0, 10_000, 10_500)).toBe(MIN_RELOAD_GAP_MS - 500);
    expect(hookReloadDelay(1, 10_000, 12_900)).toBe(HOOK_RELOAD_SETTLE_MS);
  });

  it("stops after the run's reloads, so a real hook bug reaches the auto-fix", () => {
    expect(hookReloadDelay(MAX_HOOK_RELOADS - 1, 0, 60_000)).toBe(HOOK_RELOAD_SETTLE_MS);
    expect(hookReloadDelay(MAX_HOOK_RELOADS, 0, 60_000)).toBeNull();
  });
});
