import { useAuth } from "@clerk/expo";
import { useMutation } from "convex/react";
import type { ImagePickerAsset } from "expo-image-picker";
import { useRouter } from "expo-router";

import { useAgentModel } from "@/lib/agent-model";
import { api } from "@/lib/api";
import { postApi } from "@/lib/http";

type FirstMessage = { projectId: string; text: string; images: ImagePickerAsset[] };

// A prompt with images, waiting for the new project's chat to send it.
let firstMessage: FirstMessage | undefined;

/** The prompt to send first in this project, once; undefined if there is none. */
export const takeFirstMessage = (projectId: string) => {
  if (firstMessage?.projectId !== projectId) return undefined;
  const message = firstMessage;
  firstMessage = undefined;
  return message;
};

/** "Build a habit tracker with streaks" → "build-a-habit-tracker". */
const nameFromPrompt = (prompt: string) =>
  prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .slice(0, 40) || "untitled-project";

/**
 * Creates a project through the web's create-with-prompt route (optionally
 * seeded from a starter template) with the picked agent model, and opens it
 * while the agent starts. That route takes no images, so a prompt with images
 * creates the project and its chat sends the prompt first, uploading them.
 * Resolves to an error message, or undefined once the project opens.
 */
export const useCreateProject = () => {
  const router = useRouter();
  const { getToken } = useAuth();
  const { model } = useAgentModel();
  const createEmpty = useMutation(api.projects.create);

  return async (prompt: string, templateId?: string, images: ImagePickerAsset[] = []): Promise<string | undefined> => {
    if (images.length > 0) {
      try {
        const projectId = await createEmpty({ name: nameFromPrompt(prompt) });
        firstMessage = { projectId, text: prompt, images };
        router.push(`/projects/${projectId}`);
        return undefined;
      } catch {
        return "Couldn't create the project.";
      }
    }
    try {
      const { ok, data } = await postApi<{ projectId?: string }>(
        "/api/projects/create-with-prompt",
        { prompt, model, templateId },
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
