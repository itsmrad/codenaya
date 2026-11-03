import { useEffect } from "react";
import { create } from "zustand";

interface PreviewErrors {
  /** Errors the open preview reports right now. */
  count: number;
  /** The banner's "Fix with AI"; null when no fix is on offer. */
  fix: (() => void) | null;
}

const usePreviewErrorStore = create<PreviewErrors>()(() => ({ count: 0, fix: null }));

/** What the open preview reports, for UI outside it, such as the chat's run block (#223). */
export const usePreviewErrors = () => usePreviewErrorStore();

/** Publishes the preview's errors while it is mounted. */
export const usePublishPreviewErrors = (count: number, fix: (() => void) | null) => {
  useEffect(() => {
    usePreviewErrorStore.setState({ count, fix });
  }, [count, fix]);
  useEffect(() => () => usePreviewErrorStore.setState({ count: 0, fix: null }), []);
};
