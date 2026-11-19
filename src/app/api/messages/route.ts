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
import { resolveProjectEnv, secretValuesFrom } from "@/features/integrations/server/env/resolve-env";
import { STREAM_REDACTION_PLACEHOLDER, redact } from "@/features/integrations/server/env/stream-redactor";
import {
  isAutoChoice,
  modelChoiceSchema,
  requireModelChoice,
  takePromoRun,
} from "@/features/ai-providers/server/resolve-run-model";
import { classifyRun } from "@/features/ai-providers/auto-route";
import {
  DISPATCH_FAILED_ERROR,
  cancelProcessingMessage,
  dispatchProcessMessageOrFail,
} from "@/lib/message-processor";
import { MAX_CHAT_IMAGES } from "@/features/conversations/chat-images";
import {
  MAX_SELECTED_ELEMENTS,
  selectedElementSchema,
} from "@/features/conversations/selected-elements";
import { PLAN_MODE, SWARM_MODE } from "@/features/conversations/plan-mode";
import { swarmOffResponse } from "@/features/conversations/server/swarm-off";
import { requireOwnedConversation } from "@/features/projects/server/require-owned-project";
import { FIX_PROMPT_START } from "@/features/sandbox-preview/utils/app-error";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  conversationId: z.string(),
  message: promptText,
  model: modelChoiceSchema,
  // Storage ids of images registered through api.chatImages.register.
  images: z.array(z.string()).max(MAX_CHAT_IMAGES).optional(),
  // Preview elements picked in Select mode (#227), length-capped here.
  elements: z.array(selectedElementSchema).max(MAX_SELECTED_ELEMENTS).optional(),
  // Plan mode (#120): the agent replies with a plan and writes nothing. Swarm: it leads parallel workers.
  mode: z.enum([PLAN_MODE, SWARM_MODE]).optional(),
  // A fix request ("Fix with AI" #223, loop-breaker retry #306): Auto routes it to the fix model.
  source: z.literal("fix").optional(),
});

/**
 * A preview fix prompt carries the dev server's error overlay, rendered in a
 * sandbox that holds the project's values, so it is redacted before it is stored
 * or reaches the agent. Its terminal lines are already redacted: the text between
 * their placeholders is matched, so a short value cannot match inside one. A
 * project whose values cannot be opened gets the notice instead.
 */
const redactFixPrompt = async (message: string, internalKey: string, projectId: Id<"projects">) => {
  const values = await convex
    .query(api.system.getEnvVarsForSandbox, { internalKey, projectId })
    .then((records) => resolveProjectEnv(records))
    .then(secretValuesFrom, (error) => {
      console.error("[messages] could not open the project's secrets to redact a fix", error);
      return null;
    });
  if (values === null) return redact(message, null);
  return message.split(STREAM_REDACTION_PLACEHOLDER).map((part) => redact(part, values)).join(STREAM_REDACTION_PLACEHOLDER);
};

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

  const { conversationId, message, model, images, elements, mode, source } = data;

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

  const swarmOff = await swarmOffResponse(mode);
  if (swarmOff) {
    return swarmOff;
  }

  // Auto (#322) routes by task, which needs one more read: alongside the
  // ownership check. A failed read (or a malformed id, which fails that check)
  // is a build.
  const autoTask = async () =>
    isAutoChoice(model)
      ? classifyRun({
          planMode: mode === PLAN_MODE,
          hasImages: Boolean(images?.length),
          source,
          firstBuild: await convex
            .query(api.projects.conversationNeedsFirstBuildForServer, {
              internalKey,
              conversationId: conversationId as Id<"conversations">,
            })
            .catch(() => true),
          message,
        })
      : undefined;

  // Independent reads, in parallel: each Convex round-trip delays the send.
  const [{ runModel, promoKind, rejected }, { found: conversation, notFound }] =
    await Promise.all([
      autoTask().then((task) =>
        requireModelChoice({
          internalKey,
          userId,
          model,
          withImages: Boolean(images?.length),
          task,
        }),
      ),
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

    const content = message.startsWith(FIX_PROMPT_START)
      ? await redactFixPrompt(message, internalKey, projectId)
      : message;

    // Create user message
    await convex.mutation(api.system.createMessage, {
      internalKey,
      conversationId: conversation._id,
      projectId,
      role: "user",
      content,
      // Only sent with images: only the sender's own uploads can be attached.
      ...(images?.length
        ? { images: images as Id<"_storage">[], ownerId: userId }
        : {}),
      ...(elements?.length ? { elements } : {}),
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
      message: content,
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
