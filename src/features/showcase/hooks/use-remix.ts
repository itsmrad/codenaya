import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";

import { SIGN_UP_URL } from "@/features/auth/constants";

import { Id } from "../../../../convex/_generated/dataModel";
import { savePendingRemix, takePendingRemix } from "../utils/pending-remix";
import { useImportToWorkspace } from "./use-showcase";

/** Public URL of a showcase project's detail page. */
export const showcasePath = (id: string) => `/showcase/${id}`;

/** An auth page that returns the visitor to `path` afterwards. */
export const authRedirectUrl = (authUrl: string, path: string) =>
  `${authUrl}?redirect_url=${encodeURIComponent(path)}`;

/**
 * Remix copies a showcase project into the user's workspace and opens it in
 * the IDE. Signed-out visitors are sent to sign-up first; the intent is kept
 * and finished when they come back to the project's page signed in.
 */
export const useRemix = (showcaseId: Id<"showcaseProjects">) => {
  const router = useRouter();
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const importToWorkspace = useImportToWorkspace();
  // A transition stays pending through the navigation to the IDE.
  const [isRemixing, startRemix] = useTransition();

  const copyToWorkspace = useCallback(
    () =>
      startRemix(async () => {
        try {
          const newProjectId = await importToWorkspace({ showcaseProjectId: showcaseId });
          toast.success("Remixed into your workspace!");
          router.push(`/projects/${newProjectId}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err) || "Failed to remix";
          toast.error(message);
        }
      }),
    [importToWorkspace, router, showcaseId],
  );

  const remix = () => {
    if (isRemixing || isAuthLoading) return;
    if (!isAuthenticated) {
      savePendingRemix(showcaseId);
      router.push(authRedirectUrl(SIGN_UP_URL, showcasePath(showcaseId)));
      return;
    }
    copyToWorkspace();
  };

  // Finish a Remix started while signed out. Taking the intent clears it, so
  // this runs at most once.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (takePendingRemix() === showcaseId) copyToWorkspace();
  }, [isAuthenticated, showcaseId, copyToWorkspace]);

  return { remix, isRemixing };
};
