import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";

import { postApi } from "@/lib/http";

/**
 * Creates a project through the web's create-with-prompt route (optionally
 * seeded from a starter template) and opens it while the agent starts.
 * Resolves to an error message, or undefined once the project opens.
 */
export const useCreateProject = () => {
  const router = useRouter();
  const { getToken } = useAuth();

  return async (prompt: string, templateId?: string): Promise<string | undefined> => {
    try {
      const { ok, data } = await postApi<{ projectId?: string }>(
        "/api/projects/create-with-prompt",
        { prompt, templateId },
        getToken,
      );
      // A failed dispatch (502) still created the project: open it anyway.
      if (data.projectId) {
        router.push(`/projects/${data.projectId}`);
        return undefined;
      }
      return ok ? "Something went wrong." : (data.error ?? "Couldn't create the project.");
    } catch {
      return "Couldn't reach Codenaya. Is the server running?";
    }
  };
};
