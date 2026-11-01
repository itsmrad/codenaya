import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

export type Checkpoint = FunctionReturnType<typeof api.checkpoints.list>[number];

export const useCheckpoints = (projectId: Id<"projects">) => {
  return useQuery(api.checkpoints.list, { projectId });
};

export const useRestoreCheckpoint = () => {
  return useMutation(api.checkpoints.restore);
};

export type RunChange = FunctionReturnType<typeof api.checkpoints.listChanges>[number];

/** The files a run changed, with line counts (#225). Skipped without a checkpoint. */
export const useRunChanges = (checkpointId: Id<"checkpoints"> | null | undefined) => {
  return useQuery(api.checkpoints.listChanges, checkpointId ? { checkpointId } : "skip");
};

export const useFileDiff = (checkpointId: Id<"checkpoints">, path: string | undefined) => {
  return useQuery(api.checkpoints.fileDiff, path ? { checkpointId, path } : "skip");
};

export const useRevertFile = () => {
  return useMutation(api.checkpoints.revertFile);
};
