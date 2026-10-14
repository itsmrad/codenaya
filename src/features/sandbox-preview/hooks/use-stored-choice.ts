"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Builds a hook for a small preview preference persisted per browser under
 * `key`. Every component using the hook shares the same value.
 */
export const createStoredChoice = <T extends string>(
  key: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
) => {
  const listeners = new Set<() => void>();
  let current: T | null = null;

  // localStorage can throw (private mode, blocked site data), so every access
  // is guarded; the in-memory value keeps the choice working without it.
  const read = (): T => {
    if (current) return current;
    try {
      const stored = window.localStorage.getItem(key);
      current = isValid(stored) ? stored : fallback;
    } catch {
      current = fallback;
    }
    return current;
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return function useStoredChoice() {
    const value = useSyncExternalStore(subscribe, read, () => fallback);

    const setValue = useCallback((next: T) => {
      current = next;
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Persistence is best-effort.
      }
      listeners.forEach((listener) => listener());
    }, []);

    return [value, setValue] as const;
  };
};
