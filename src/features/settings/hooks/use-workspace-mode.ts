"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQueries } from "convex/react";

import {
  DEFAULT_WORKSPACE_MODE,
  type WorkspaceMode,
  cacheWorkspaceMode,
  loadCachedWorkspaceMode,
  resolveWorkspaceMode,
} from "@/features/projects/utils/workspace-mode";

import { api } from "../../../../convex/_generated/api";

const noopSubscribe = () => () => {};

// `useQueries` hands back a failure (e.g. a backend without these functions
// yet) as an Error instead of throwing it into the page's error boundary.
const WORKSPACE_MODE_QUERY = { mode: { query: api.userPreferences.getWorkspaceMode, args: {} } };

/**
 * The account's workspace mode (#524). Until the query resolves, or if it
 * fails, it is the last value seen on this device ("ide" if none), so a
 * project opens without a layout flash or a crash.
 */
export const useWorkspaceMode = () => {
  const saved = useQueries(WORKSPACE_MODE_QUERY).mode as WorkspaceMode | Error | undefined;
  const cached = useSyncExternalStore(
    noopSubscribe,
    loadCachedWorkspaceMode,
    () => DEFAULT_WORKSPACE_MODE,
  );
  const failed = saved instanceof Error;
  useEffect(() => {
    if (saved && !(saved instanceof Error)) cacheWorkspaceMode(saved);
  }, [saved]);
  return { mode: resolveWorkspaceMode(saved, cached), loaded: saved !== undefined && !failed, failed };
};

export const useSetWorkspaceMode = () =>
  useMutation(api.userPreferences.setWorkspaceMode).withOptimisticUpdate(
    (store, { workspaceMode }) => {
      store.setQuery(api.userPreferences.getWorkspaceMode, {}, workspaceMode);
    },
  );
