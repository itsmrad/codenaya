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

/**
 * A toast's Undo action that runs `undo` once however often it's clicked:
 * sonner keeps the button clickable through its exit animation (#259).
 */
export const undoAction = (undo: () => void) => {
  let done = false;
  return {
    label: "Undo",
    onClick: () => {
      if (done) return;
      done = true;
      undo();
    },
  };
};

export type RunChange = NonNullable<FunctionReturnType<typeof api.checkpoints.listChanges>>[number];

/**
 * The files a run changed, with line counts (#225). Skipped without a
 * checkpoint. Null when the run touched too many files to diff; an Error when
 * the query failed, returned rather than thrown so it can't take the chat down.
 */
export const useRunChanges = (
  checkpointId: Id<"checkpoints"> | null | undefined,
): RunChange[] | null | undefined | Error => {
  // `useQueries` hands back a failure as an Error instead of throwing it.
  const queries = useMemo(() => {
    const request: RequestForQueries = {};
    if (checkpointId) request.changes = { query: api.checkpoints.listChanges, args: { checkpointId } };
    return request;
  }, [checkpointId]);
  return useQueries(queries).changes;
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
