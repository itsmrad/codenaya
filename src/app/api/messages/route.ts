import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody, promptText } from "@/lib/parse-json-body";
import {
  AGENT_MESSAGE_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/lib/rate-limit";

import { convex } from "@/lib/convex-client";
import { detectCredential } from "@/features/integrations/credential-guard";
import {
  modelChoiceSchema,
  requireModelChoice,
  takePromoRun,
} from "@/features/ai-providers/server/resolve-run-model";
import {
  DISPATCH_FAILED_ERROR,
  cancelProcessingMessage,
  dispatchProcessMessageOrFail,
} from "@/lib/message-processor";
import { MAX_CHAT_IMAGES } from "@/features/conversations/chat-images";
import { PLAN_MODE } from "@/features/conversations/plan-mode";
import { requireOwnedConversation } from "@/features/projects/server/require-owned-project";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  conversationId: z.string(),
  message: promptText,
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

  const rateLimit = checkRateLimit(userId, AGENT_MESSAGE_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Internal key not configured" },
      { status: 500 }
    );
  }

  const { data, invalid } = await parseJsonBody(request, requestSchema);

  if (invalid) {
    return invalid;
  }

  const { conversationId, message, model, images, mode } = data;

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

  // Independent reads, in parallel: each Convex round-trip delays the send.
  const [{ runModel, promoKind, rejected }, { found: conversation, notFound }] =
    await Promise.all([
      requireModelChoice({
        internalKey,
        userId,
        model,
        withImages: Boolean(images?.length),
      }),
      requireOwnedConversation({
        internalKey,
        userId,
        conversationId,
      }),
    ]);

  if (rejected) {
    return rejected;
  }

  if (notFound) {
    return notFound;
  }

  // After the ownership check and before anything changes (ADR 0009).
  const { promoRun, rejected: promoRejected } = await takePromoRun({
    internalKey,
    userId,
    promoKind,
  });

  if (promoRejected) {
    return promoRejected;
  }

  // A send that fails before its agent run starts gives its promo run back.
  try {
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
      conversationId: conversation._id,
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
        conversationId: conversation._id,
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
      conversationId: conversation._id,
      projectId,
      ownerId: userId,
      message,
      model: runModel,
      mode,
    });

    if (!dispatch) {
      // The user retries from the chat; that send takes its own run.
      await promoRun.refund();
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
      messageId: assistantMessageId,
    });
  } catch (error) {
    await promoRun.refund();
    throw error;
  }
};
