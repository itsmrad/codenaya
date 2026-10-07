import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";

import { api } from "../../../../convex/_generated/api";

/**
 * Creates the signed-in user's Convex row on sign-in, in case Clerk's
 * `user.created` webhook has not arrived yet. Idempotent on the server.
 */
export const useEnsureCurrentUser = () => {
  const { isAuthenticated } = useConvexAuth();
  const ensureCurrent = useMutation(api.users.ensureCurrent);

  useEffect(() => {
    if (!isAuthenticated) return;
    ensureCurrent().catch((error: unknown) => {
      console.error("Failed to sync the signed-in user", error);
    });
  }, [isAuthenticated, ensureCurrent]);
};
