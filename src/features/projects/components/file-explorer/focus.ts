import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// null identifies the explorer header's Create file button.
type FocusRequest = { id: string | null };

// Folder creation returns no id; match its confirmed row by parent and name.
export const folderFocusKey = (parentId: string | undefined, name: string) =>
  JSON.stringify([parentId ?? null, name]);

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
    alias?: string,
  ) => {
    const target = pending.current;
    if (button && target && (target.id === id || (alias !== undefined && target.id === alias))) {
      pending.current = null;
      button.focus();
    }
  }, []);
  return { request, requestFocus, focusIfRequested };
}

export const ExplorerFocusContext = createContext<ReturnType<typeof useExplorerFocusController> | null>(null);

export function useExplorerFocusTarget(id: string | null, alias?: string) {
  const focus = useContext(ExplorerFocusContext);
  const ref = useRef<HTMLButtonElement>(null);
  const request = focus?.request;
  const focusIfRequested = focus?.focusIfRequested;
  useEffect(() => {
    focusIfRequested?.(id, ref.current, alias);
  }, [id, alias, request, focusIfRequested]);
  return ref;
}
