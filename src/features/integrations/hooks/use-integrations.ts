import { useMutation, useQuery } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Convex bindings for the integrations panel.
 *
 * Mirrors the shape of `src/features/projects/hooks/use-projects.ts` so the two
 * feature areas read the same way.
 *
 * Every query here is authenticated as the signed-in user and returns only
 * browser-safe projections — the underlying Convex functions never read the
 * sealed credential fields.
 */

/** Every connection the signed-in user holds, newest first. */
export const useUserConnections = () => {
  return useQuery(api.integrations.listUserConnections);
};

/**
 * Connections attached to one project, each with its per-project scope.
 *
 * Pass `undefined` to skip the query — used while a projectId is still resolving.
 */
export const useProjectConnections = (projectId: Id<"projects"> | undefined) => {
  return useQuery(
    api.integrations.listProjectConnections,
    projectId ? { projectId } : "skip",
  );
};

/**
 * Delete a credential. Resolves with how many project links were removed so the
 * caller can tell the user what else changed.
 */
export const useDeleteUserConnection = () => {
  return useMutation(api.integrations.deleteUserConnection);
};

export const useLinkConnectionToProject = () => {
  return useMutation(api.integrations.linkConnectionToProject);
};

export const useUpdateProjectConnection = () => {
  return useMutation(api.integrations.updateProjectConnection);
};

export const useUnlinkProjectConnection = () => {
  return useMutation(api.integrations.unlinkProjectConnection);
};

/** Pending destructive-tool approvals awaiting the user's decision. */
export const usePendingApprovals = (projectId: Id<"projects"> | undefined) => {
  return useQuery(
    api.integrations.listPendingApprovals,
    projectId ? { projectId } : "skip",
  );
};

export const useResolveApproval = () => {
  return useMutation(api.integrations.resolveApproval);
};
