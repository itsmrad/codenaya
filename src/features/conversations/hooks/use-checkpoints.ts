import { useMemo } from "react";
import { type RequestForQueries, useMutation, useQueries, useQuery } from "convex/react";
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

export type RunChange = NonNullable<FunctionReturnType<typeof api.checkpoints.listChanges>>[number];

/**
 * The files a run changed, with line counts (#225). Skipped without a
 * checkpoint. Null when there is no diff to show (too many files, or the query
 * failed): a failed diff must not throw and take the chat down with it.
 */
export const useRunChanges = (
  checkpointId: Id<"checkpoints"> | null | undefined,
): RunChange[] | null | undefined => {
  // `useQueries` hands back a failure as an Error instead of throwing it.
  const queries = useMemo(() => {
    const request: RequestForQueries = {};
    if (checkpointId) request.changes = { query: api.checkpoints.listChanges, args: { checkpointId } };
    return request;
  }, [checkpointId]);
  const result = useQueries(queries).changes;
  return result instanceof Error ? null : result;
};

/** One file's diff, or an Error when it failed to load (not thrown, see above). */
export const useFileDiff = (
  checkpointId: Id<"checkpoints">,
  path: string,
): FunctionReturnType<typeof api.checkpoints.fileDiff> | Error | undefined => {
  const queries = useMemo(
    () => ({ diff: { query: api.checkpoints.fileDiff, args: { checkpointId, path } } }),
    [checkpointId, path],
  );
  return useQueries(queries).diff;
};

export const useRevertFile = () => {
  return useMutation(api.checkpoints.revertFile);
};
