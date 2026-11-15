import type { AppError } from "./app-error";

/**
 * A dependency first imported after Vite booted makes it re-optimize. A page that
 * takes the update without Vite's follow-up full reload runs two React copies and
 * throws a hook error until it is reloaded (#486).
 */
const HOOK_ERROR = /Invalid hook call|Cannot read properties of null \(reading 'use[A-Z]\w*'\)/;

/** Wait for Vite's own reload to arrive first; it makes ours unnecessary. */
export const HOOK_RELOAD_SETTLE_MS = 1000;
/** No reload within this long of another one (first-build end, startup refresh). */
export const MIN_RELOAD_GAP_MS = 3000;
/** Per run: a hook bug that survives its reloads reaches the auto-fix instead. */
export const MAX_HOOK_RELOADS = 2;

export const isHookError = (error: AppError | null) =>
  error?.kind === "runtime" && HOOK_ERROR.test(error.message);

/** Ms until the preview reloads for a hook error, or null once the run used its reloads. */
export const hookReloadDelay = (hookReloads: number, lastReloadAt: number, now: number) =>
  hookReloads >= MAX_HOOK_RELOADS
    ? null
    : Math.max(HOOK_RELOAD_SETTLE_MS, lastReloadAt + MIN_RELOAD_GAP_MS - now);
