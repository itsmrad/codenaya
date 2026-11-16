import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// null identifies the explorer header's Create file button.
type FocusRequest = { id: string | null };

// A created entry is found by parent and name (folders return no id), on the
// confirmed row only: optimistic rows carry no key.
export const entryFocusKey = (parentId: string | undefined, name: string) =>
  JSON.stringify([parentId ?? null, name]);

/**
 * Restoring focus must not steal it: only act when focus was lost (nothing
 * focused, or it sat in the dialog/menu that just closed). A click elsewhere
 * or an entry that already took focus keeps it.
 */
export const isFocusLost = (
  active: Pick<Element, "isConnected" | "closest"> | null,
  body: unknown,
) => !active || active === body || !active.isConnected || active.closest('[role="alertdialog"], [role="dialog"], [role="menu"]') !== null;

const defaultFind = (key: string) =>
  document.querySelector<HTMLElement>(`[data-explorer-entry="${CSS.escape(key)}"]`);

/** Focuses the confirmed row for `key` as soon as it is in the DOM (it appears when the server's row replaces the optimistic one). */
export const focusEntryWhenMounted = (
  key: string,
  find: (key: string) => HTMLElement | null = defaultFind,
  raf: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
  maxFrames = 180,
) => {
  let frames = 0;
  const tick = () => {
    const element = find(key);
    if (element) element.focus();
    else if (++frames < maxFrames) raf(tick);
  };
  tick();
};

export function useExplorerFocusController() {
  const [request, setRequest] = useState<FocusRequest | null>(null);
  const pending = useRef<FocusRequest | null>(null);
  const requestFocus = useCallback((id: string | null) => {
    const next = { id };
    pending.current = next;
    setRequest(next);
  }, []);
  const focusIfRequested = useCallback((
    id: string | null,
    button: HTMLButtonElement | null,
  ) => {
    const target = pending.current;
    if (button && target && target.id === id) {
      pending.current = null;
      if (isFocusLost(document.activeElement, document.body)) button.focus();
    }
  }, []);
  return { request, requestFocus, focusIfRequested };
}

export const ExplorerFocusContext = createContext<ReturnType<typeof useExplorerFocusController> | null>(null);

export function useExplorerFocusTarget(id: string | null) {
  const focus = useContext(ExplorerFocusContext);
  const ref = useRef<HTMLButtonElement>(null);
  const request = focus?.request;
  const focusIfRequested = focus?.focusIfRequested;
  useEffect(() => {
    focusIfRequested?.(id, ref.current);
  }, [id, request, focusIfRequested]);
  return ref;
}
