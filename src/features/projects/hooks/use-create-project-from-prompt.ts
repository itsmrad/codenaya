"use client";

import { useCallback, useState } from "react";
import ky, { HTTPError } from "ky";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Id } from "../../../../convex/_generated/dataModel";
import { detectCredential } from "@/features/integrations/credential-guard";
import { useAgentModel } from "@/features/conversations/hooks/use-agent-model";
import type { StarterTemplateId } from "@/features/templates/templates";

const CREDENTIAL_ERROR =
  "Remove credentials from the prompt. Create the project first, then add the MCP connection through Integrations.";

/**
 * Creates a project from a prompt (which also starts the agent on it) and
 * opens it in the IDE, using the agent model picked in the composer or chat.
 * A `templateId` seeds the project with that starter template's files first.
 * `createProject` resolves to true once it navigates, so callers can clear
 * their input or close a dialog.
 */
export const useCreateProjectFromPrompt = () => {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentModel] = useAgentModel();

  const createProject = useCallback(
    async (prompt: string, templateId?: StarterTemplateId): Promise<boolean> => {
      const text = prompt.trim();
      if (!text) return false;

      if (detectCredential(text).detected) {
        toast.error(CREDENTIAL_ERROR);
        return false;
      }

      setIsSubmitting(true);

      try {
        const { projectId } = await ky
          .post("/api/projects/create-with-prompt", {
            json: { prompt: text, model: agentModel, templateId },
          })
          .json<{ projectId: Id<"projects"> }>();

        toast.success("Project created");
        router.push(`/projects/${projectId}`);
        return true;
      } catch (error) {
        if (error instanceof HTTPError) {
          const body = await error.response
            .json<{ code?: string; error?: string; projectId?: Id<"projects"> }>()
            .catch(() => ({ code: undefined, error: undefined, projectId: undefined }));
          // The project was created but its agent run could not start: open it
          // anyway, where the failed reply offers a retry.
          if (body.code === "dispatch_failed" && body.projectId) {
            toast.error("Project created, but the agent couldn't start. Retry from the chat.");
            router.push(`/projects/${body.projectId}`);
            return true;
          }
          if (body.code === "credential_detected") {
            toast.error(body.error ?? CREDENTIAL_ERROR);
            return false;
          }
        }
        toast.error("Unable to create project");
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [router, agentModel],
  );

  return { createProject, isSubmitting };
};
