"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";

import {
  DEFAULT_WORKSPACE_MODE,
  cacheWorkspaceMode,
  loadCachedWorkspaceMode,
} from "@/features/projects/utils/workspace-mode";

import { api } from "../../../../convex/_generated/api";

const noopSubscribe = () => () => {};

/**
 * The account's workspace mode (#524). Until the query resolves it is the
 * last value seen on this device, so a project opens without a layout flash.
 */
export const useWorkspaceMode = () => {
  const saved = useQuery(api.userPreferences.getWorkspaceMode);
  const cached = useSyncExternalStore(
    noopSubscribe,
    loadCachedWorkspaceMode,
    () => DEFAULT_WORKSPACE_MODE,
  );
  useEffect(() => {
    if (saved) cacheWorkspaceMode(saved);
  }, [saved]);
  return { mode: saved ?? cached, loaded: saved !== undefined };
};

export const useSetWorkspaceMode = () =>
  useMutation(api.userPreferences.setWorkspaceMode).withOptimisticUpdate(
    (store, { workspaceMode }) => {
      store.setQuery(api.userPreferences.getWorkspaceMode, {}, workspaceMode);
    },
  );
