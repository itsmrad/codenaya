import { useSyncExternalStore } from "react";

function subscribe() {
  // navigator.userAgent never changes, so no subscription needed
  return () => {};
}

function getSnapshot(): boolean {
  return /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
}

function getServerSnapshot(): boolean {
  // Default to true (Mac-style) during SSR to match initial client render
  return true;
}

/**
 * SSR-safe hook to detect macOS/iOS platforms.
 * Returns `true` on Mac/iOS, `false` on other platforms.
 * Uses `useSyncExternalStore` to avoid hydration mismatches.
 */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
