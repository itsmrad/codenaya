import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import { convex } from "@/lib/convex-client";
import { detectCredential } from "@/features/integrations/credential-guard";
import {
  modelChoiceSchema,
  requireModelChoice,
} from "@/features/ai-providers/server/resolve-run-model";
import {
  DISPATCH_FAILED_ERROR,
  cancelProcessingMessage,
  dispatchProcessMessageOrFail,
} from "@/lib/message-processor";
import { MAX_CHAT_IMAGES } from "@/features/conversations/chat-images";
import { PLAN_MODE } from "@/features/conversations/plan-mode";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  conversationId: z.string(),
  message: z.string(),
  model: modelChoiceSchema,
  // Storage ids of images registered through api.chatImages.register.
  images: z.array(z.string()).max(MAX_CHAT_IMAGES).optional(),
  // Plan mode (#120): the agent replies with a plan and writes nothing.
  mode: z.literal(PLAN_MODE).optional(),
});

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Internal key not configured" },
      { status: 500 }
    );
  }

  const body = await request.json();
  const { conversationId, message, model, images, mode } = requestSchema.parse(body);

  if (detectCredential(message).detected) {
    return NextResponse.json(
      {
        error:
          "Credentials cannot be sent in chat. Use the secure Integrations flow.",
        code: "credential_detected",
      },
      { status: 422 },
    );
  }

  const { runModel, rejected } = await requireModelChoice({
    internalKey,
    userId,
    model,
    withImages: Boolean(images?.length),
  });

  if (rejected) {
    return rejected;
  }

  // Call convex mutation, query
  const conversation = await convex.query(api.system.getConversationById, {
    internalKey,
    conversationId: conversationId as Id<"conversations">,
  });

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  const projectId = conversation.projectId;

  // Find all processing messages in this project
  const processingMessages = await convex.query(
    api.system.getProcessingMessages,
    {
      internalKey,
      projectId,
    }
  );

  if (processingMessages.length > 0) {
    // Cancel all processing messages
    await Promise.all(
      processingMessages.map((msg) =>
        cancelProcessingMessage({ internalKey, messageId: msg._id })
      )
    );
  }

  // Create user message
  await convex.mutation(api.system.createMessage, {
    internalKey,
    conversationId: conversationId as Id<"conversations">,
    projectId,
    role: "user",
    content: message,
    // Only sent with images: only the sender's own uploads can be attached.
    ...(images?.length
      ? { images: images as Id<"_storage">[], ownerId: userId }
      : {}),
  });

  // Create assistant message placeholder with processing status
  const assistantMessageId = await convex.mutation(
    api.system.createMessage,
    {
      internalKey,
      conversationId: conversationId as Id<"conversations">,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
      runModel,
      mode,
    }
  );

  // Trigger the configured message processor (Inngest or Vercel Workflow)
  const dispatch = await dispatchProcessMessageOrFail({
    internalKey,
    messageId: assistantMessageId,
    conversationId: conversationId as Id<"conversations">,
    projectId,
    message,
    model: runModel,
    mode,
  });

  if (!dispatch) {
    return NextResponse.json(
      {
        error: DISPATCH_FAILED_ERROR,
        code: "dispatch_failed",
        messageId: assistantMessageId,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    backend: dispatch.backend,
    eventId: dispatch.eventId,
    runId: dispatch.runId,
    messageId: assistantMessageId,
  });
};
