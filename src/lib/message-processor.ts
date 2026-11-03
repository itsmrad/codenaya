import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import type { AgentModelChoice } from "@/features/conversations/agent-models";
import type { MessageMode } from "@/features/conversations/plan-mode";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

interface ProcessMessageDispatchInput {
  internalKey: string;
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  /** The project owner, the key of the per-user agent run concurrency (#242). */
  ownerId: string;
  message: string;
  /** Validated model choice; omitted means the platform default. */
  model?: AgentModelChoice;
  /** Plan mode (#120): no write tools; omitted means build. */
  mode?: MessageMode;
}

interface DispatchResult {
  /** Always Inngest since the Workflow backend was retired (ADR 0005); kept for API clients. */
  backend: "inngest";
  eventId?: string;
}

/** Dispatches a "user sent a message" event to the Inngest agent. */
export async function dispatchProcessMessage(
  input: ProcessMessageDispatchInput,
): Promise<DispatchResult> {
  const event = await inngest.send({
    name: "message/sent",
    data: {
      messageId: input.messageId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      message: input.message,
      model: input.model
        ? { keyId: input.model.keyId, modelId: input.model.modelId }
        : undefined,
      mode: input.mode,
    },
  });

  return { backend: "inngest", eventId: event.ids[0] };
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
        outcome: "error",
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

/** Cancels in-flight processing for a single assistant message. */
export async function dispatchCancelMessage(opts: { messageId: Id<"messages"> }) {
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
