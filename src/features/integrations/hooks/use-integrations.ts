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


// ─── Environment variables ───

/** Every variable for a project. Secret values are masked, never returned. */
export const useEnvVars = (projectId: Id<"projects"> | undefined) => {
  return useQuery(
    api.envVars.listEnvVars,
    projectId ? { projectId } : "skip",
  );
};

/**
 * Public variables as plain key/value pairs.
 *
 * This is what the WebContainer preview mounts. The underlying Convex query never
 * reads the sealed fields, so it is structurally incapable of returning a secret.
 */
export const usePublicEnvVars = (projectId: Id<"projects"> | undefined) => {
  return useQuery(
    api.envVars.listPublicEnvVars,
    projectId ? { projectId } : "skip",
  );
};

/**
 * How many secrets exist without exposing them.
 *
 * Lets the WebContainer preview explain that variables are missing, rather than the
 * generated app failing with a confusing runtime error the user cannot trace.
 */
export const useWithheldSecretCount = (
  projectId: Id<"projects"> | undefined,
) => {
  return useQuery(
    api.envVars.countWithheldSecrets,
    projectId ? { projectId } : "skip",
  );
};

export const useSetPublicEnvVar = () => {
  return useMutation(api.envVars.setPublicEnvVar);
};

export const useDeleteEnvVar = () => {
  return useMutation(api.envVars.deleteEnvVar);
};
