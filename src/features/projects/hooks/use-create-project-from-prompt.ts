"use client";

import { useCallback, useRef, useState } from "react";
import ky, { HTTPError } from "ky";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Id } from "../../../../convex/_generated/dataModel";
import { detectCredential } from "@/features/integrations/credential-guard";
import { useAgentModel } from "@/features/conversations/hooks/use-agent-model";
import type { AgentModelChoice } from "@/features/conversations/agent-models";
import type { ComposerMode } from "@/features/conversations/components/plan-mode-toggle";
import { askSetupQuestions } from "@/features/conversations/components/setup-questions-dialog";
import {
  shouldAskSetupQuestions,
  withSetupAnswers,
  withSetupDecisions,
} from "@/features/conversations/setup-questions";
import type { StarterTemplateId } from "@/features/templates/templates";
import { INSUFFICIENT_CREDITS_CODE } from "@/features/billing/credits";
import { MODEL_LIMIT_CODE } from "@/features/billing/model-spend";
import { isPromoRefusalCode } from "@/features/promotions/github-promo";

import { clearPendingPrompt } from "../utils/pending-prompt";
import { useUpdateProjectInstructions } from "./use-projects";

const CREDENTIAL_ERROR =
  "Remove credentials from the prompt. Create the project first, then add the MCP connection through Integrations.";

/** The create-with-prompt body; build omits the mode, as the chat composer does. */
export const createWithPromptBody = (
  prompt: string,
  model: AgentModelChoice,
  templateId?: StarterTemplateId,
  fromLanding?: boolean,
  mode?: ComposerMode,
) => ({
  prompt,
  model,
  templateId,
  fromLanding,
  ...(mode && mode !== "build" ? { mode } : {}),
});

/**
 * Creates a project from a prompt (which also starts the agent on it) and
 * opens it in the IDE, using the agent model picked in the composer or chat.
 * A `templateId` seeds the project with that starter template's files first;
 * `fromLanding` marks a prompt typed on the landing page before sign-up;
 * `mode` starts the first run in Ask / Plan or Swarm mode.
 * `createProject` resolves to true once it navigates, so callers can clear
 * their input or close a dialog.
 */
export const useCreateProjectFromPrompt = () => {
  const router = useRouter();
  const submitting = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentModel] = useAgentModel();
  const updateInstructions = useUpdateProjectInstructions();

  const createProject = useCallback(
    async (
      prompt: string,
      templateId?: StarterTemplateId,
      fromLanding?: boolean,
      mode?: ComposerMode,
    ): Promise<boolean> => {
      if (submitting.current) return false;
      const text = prompt.trim();
      if (!text) return false;

      // A landing draft with a credential can never be created as written: drop it so Retry isn't offered.
      if (detectCredential(text).detected) {
        if (fromLanding) clearPendingPrompt();
        toast.error(CREDENTIAL_ERROR);
        return false;
      }

      submitting.current = true;
      setIsSubmitting(true);
      try {
        // Lock before setup questions too: state alone cannot block same-tick calls.
        const answers = !templateId && shouldAskSetupQuestions(text) ? await askSetupQuestions() : null;
        if (answers === undefined) return false;

        const { projectId } = await ky
          .post("/api/projects/create-with-prompt", {
            json: createWithPromptBody(withSetupAnswers(text, answers), agentModel, templateId, fromLanding, mode),
          })
          .json<{ projectId: Id<"projects"> }>();

        // Kept for every later run; the first prompt has them either way.
        const instructions = withSetupDecisions(undefined, answers);
        if (instructions) {
          updateInstructions({ id: projectId, instructions }).catch((error) =>
            console.warn("[setup-questions] couldn't save the decisions", error),
          );
        }

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
            if (fromLanding) clearPendingPrompt();
            toast.error(body.error ?? CREDENTIAL_ERROR);
            return false;
          }
          // Platform AI has no key, a promo model can't run, credits ran out,
          // or Swarm is switched off; nothing was created.
          const refused =
            body.code === "ai_not_configured" ||
            body.code === "swarm_disabled" ||
            body.code === INSUFFICIENT_CREDITS_CODE ||
            body.code === MODEL_LIMIT_CODE ||
            isPromoRefusalCode(body.code);
          if (refused && body.error) {
            toast.error(body.error);
            return false;
          }
        }
        toast.error("Unable to create project");
        return false;
      } finally {
        submitting.current = false;
        setIsSubmitting(false);
      }
    },
    [router, agentModel, updateInstructions],
  );

  return { createProject, isSubmitting };
};
