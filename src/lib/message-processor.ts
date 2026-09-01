import { inngest } from "@/inngest/client";
import {
  cancelProcessMessageWorkflowByMessageId,
  startProcessMessageWorkflow,
} from "@/features/conversations/workflow/client";
import { isVertexConfigured } from "@/features/conversations/workflow/lib/vertex-model";

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
