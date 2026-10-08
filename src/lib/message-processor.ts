import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";
import {
  cancelProcessMessageWorkflowByMessageId,
  startProcessMessageWorkflow,
} from "@/features/conversations/workflow/client";
import { isVertexConfigured } from "@/features/conversations/workflow/lib/vertex-model";

import type { AgentModelChoice } from "@/features/conversations/agent-models";
import type { MessageMode } from "@/features/conversations/plan-mode";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export type MessageProcessorBackend = "inngest" | "workflow";

/**
 * Reads the configured backend from the `MESSAGE_PROCESSOR` env variable.
 * Defaults to `inngest` to keep existing behaviour unchanged. Set to
 * `workflow` to route message processing through the Vercel Workflow SDK
 * implementation.
 *
 * Inngest is the primary backend; Workflow is its fallback. Because the
 * Workflow implementation runs its agent on Google Vertex, selecting it without
 * Vertex credentials would fail on every message. Rather than accept that, an
 * unusable `workflow` selection degrades to `inngest` and warns — a fallback
 * that cannot run is worse than no fallback, because the failure surfaces only
 * once the primary is already down.
 */
export function getMessageProcessorBackend(): MessageProcessorBackend {
  const value = process.env.MESSAGE_PROCESSOR?.toLowerCase().trim();

  if (value !== "workflow") {
    return "inngest";
  }

  if (!isVertexConfigured()) {
    console.warn(
      "[message-processor] MESSAGE_PROCESSOR=workflow but Vertex credentials " +
        "(GOOGLE_VERTEX_PROJECT / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY) are " +
        "missing. Falling back to the Inngest backend.",
    );
    return "inngest";
  }

  return "workflow";
}

interface ProcessMessageDispatchInput {
  internalKey: string;
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
  /**
   * Validated model choice; omitted means the platform default. Inngest only:
   * the Workflow backend always runs on Vertex with the platform key.
   */
  model?: AgentModelChoice;
  /** Plan mode (#120): no write tools; omitted means build. */
  mode?: MessageMode;
}

interface DispatchResult {
  backend: MessageProcessorBackend;
  /** Inngest event id (if backend === "inngest"). */
  eventId?: string;
  /** Workflow run id (if backend === "workflow"). */
  runId?: string;
}

/**
 * Dispatches a "user sent a message" event to the configured backend.
 * The two backends behave equivalently from the caller's perspective.
 */
export async function dispatchProcessMessage(
  input: ProcessMessageDispatchInput,
): Promise<DispatchResult> {
  const backend = getMessageProcessorBackend();

  if (backend === "workflow") {
    if (input.model?.keyId) {
      console.warn(
        "[message-processor] BYOK model requested on the Workflow backend; " +
          "running on the platform Vertex model instead.",
      );
    }
    const runId = await startProcessMessageWorkflow(input);
    return { backend, runId };
  }

  const event = await inngest.send({
    name: "message/sent",
    data: {
      messageId: input.messageId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      message: input.message,
      model: input.model
        ? { keyId: input.model.keyId, modelId: input.model.modelId }
        : undefined,
      mode: input.mode,
    },
  });

  return { backend, eventId: event.ids[0] };
}

/** Written in place of the reply when the agent could not be started. */
export const DISPATCH_FAILED_MESSAGE =
  "I couldn't start working on this because the agent service is unreachable. Please try again in a moment.";

/** API error for a request whose agent run could not be started. */
export const DISPATCH_FAILED_ERROR =
  "The agent service is unavailable. Please try again.";

/**
 * Dispatches like `dispatchProcessMessage`, but if the backend cannot be
 * reached it resolves the assistant placeholder with `DISPATCH_FAILED_MESSAGE`
 * and returns null. Otherwise the placeholder would stay "processing" forever:
 * a spinner across reloads and a composer that only Stop can unlock.
 */
export async function dispatchProcessMessageOrFail(
  input: ProcessMessageDispatchInput,
): Promise<DispatchResult | null> {
  try {
    return await dispatchProcessMessage(input);
  } catch (error) {
    console.error("[message-processor] Failed to dispatch message", error);

    await convex
      .mutation(api.system.updateMessageContent, {
        internalKey: input.internalKey,
        messageId: input.messageId,
        content: DISPATCH_FAILED_MESSAGE,
      })
      .catch((updateError) => {
        console.error(
          "[message-processor] Failed to mark undispatched message failed",
          updateError,
        );
      });

    return null;
  }
}

/**
 * Cancels in-flight processing for a single assistant message. Routes to the
 * configured backend.
 */
export async function dispatchCancelMessage(opts: {
  internalKey: string;
  messageId: Id<"messages">;
}) {
  const backend = getMessageProcessorBackend();

  if (backend === "workflow") {
    return cancelProcessMessageWorkflowByMessageId(opts);
  }

  await inngest.send({
    name: "message/cancel",
    data: { messageId: opts.messageId },
  });
  return true;
}

/**
 * Stops a processing message: asks the backend to cancel its run, then marks
 * the message cancelled. The status is written even when the backend is
 * unreachable, so an orphaned "processing" message can always be cleared.
 */
export async function cancelProcessingMessage(opts: {
  internalKey: string;
  messageId: Id<"messages">;
}) {
  try {
    await dispatchCancelMessage(opts);
  } catch (error) {
    console.error("[message-processor] Failed to dispatch cancel", error);
  }

  await convex.mutation(api.system.updateMessageStatus, {
    internalKey: opts.internalKey,
    messageId: opts.messageId,
    status: "cancelled",
  });
}
