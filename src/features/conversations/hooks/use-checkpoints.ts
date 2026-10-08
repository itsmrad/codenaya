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
