import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";

import { SIGN_UP_URL } from "@/features/auth/constants";
import { convexErrorMessage } from "@/lib/convex-error";

import { Id } from "../../../../convex/_generated/dataModel";
import { savePendingRemix, takePendingRemix } from "../utils/pending-remix";

/** Public URL of a showcase project's detail page. */
export const showcasePath = (id: string) => `/showcase/${id}`;

/** An auth page that returns the visitor to `path` afterwards. */
export const authRedirectUrl = (authUrl: string, path: string) =>
  `${authUrl}?redirect_url=${encodeURIComponent(path)}`;

/**
 * Remix copies a project (a showcase entry or a share link, #260) into the
 * user's workspace with `copy` and opens it in the IDE. Signed-out visitors
 * are sent to sign-up first; the intent is kept and finished when they come
 * back to `sourcePath` signed in. `copy` must be stable (`useCallback`).
 */
export const useRemix = (sourcePath: string, copy: () => Promise<Id<"projects">>) => {
  const router = useRouter();
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  // A transition stays pending through the navigation to the IDE.
  const [isRemixing, startRemix] = useTransition();

  const copyToWorkspace = useCallback(
    () =>
      startRemix(async () => {
        try {
          const newProjectId = await copy();
          toast.success("Remixed into your workspace!");
          router.push(`/projects/${newProjectId}`);
        } catch (err: unknown) {
          toast.error(convexErrorMessage(err, "Failed to remix"));
        }
      }),
    [copy, router],
  );

  const remix = () => {
    if (isRemixing || isAuthLoading) return;
    if (!isAuthenticated) {
      savePendingRemix(sourcePath);
      router.push(authRedirectUrl(SIGN_UP_URL, sourcePath));
      return;
    }
    copyToWorkspace();
  };

  // Finish a Remix started while signed out. Taking the intent clears it, so
  // this runs at most once.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (takePendingRemix() === sourcePath) copyToWorkspace();
  }, [isAuthenticated, sourcePath, copyToWorkspace]);

  return { remix, isRemixing };
};
