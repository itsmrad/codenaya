import { inngest } from "@/inngest/client";
import {
  cancelProcessMessageWorkflowByMessageId,
  startProcessMessageWorkflow,
} from "@/features/conversations/workflow/client";

import type { Id } from "../../convex/_generated/dataModel";

export type MessageProcessorBackend = "inngest" | "workflow";

/**
 * Reads the configured backend from the `MESSAGE_PROCESSOR` env variable.
 * Defaults to `inngest` to keep existing behaviour unchanged. Set to
 * `workflow` to route message processing through the Vercel Workflow SDK
 * implementation.
 */
export function getMessageProcessorBackend(): MessageProcessorBackend {
  const value = process.env.MESSAGE_PROCESSOR?.toLowerCase().trim();
  return value === "workflow" ? "workflow" : "inngest";
}

interface ProcessMessageDispatchInput {
  internalKey: string;
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
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
    },
  });

  return { backend, eventId: event.ids[0] };
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
