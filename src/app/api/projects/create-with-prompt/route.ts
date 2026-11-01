import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody, promptText } from "@/lib/parse-json-body";
import {
  CREATE_WITH_PROMPT_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/lib/rate-limit";

import { DEFAULT_CONVERSATION_TITLE } from "@/features/conversations/constants";
import {
  modelChoiceSchema,
  requireModelChoice,
  takePromoRun,
} from "@/features/ai-providers/server/resolve-run-model";

import { convex } from "@/lib/convex-client";
import { generateProjectName } from "@/lib/project-names";
import {
  DISPATCH_FAILED_ERROR,
  dispatchProcessMessageOrFail,
} from "@/lib/message-processor";
import { detectCredential } from "@/features/integrations/credential-guard";
import { seedTemplateFiles } from "@/features/templates/server/seed-template";
import {
  STARTER_TEMPLATE_IDS,
  getStarterTemplate,
} from "@/features/templates/templates";

import { api } from "../../../../../convex/_generated/api";

const requestSchema = z.object({
  prompt: promptText.min(1),
  model: modelChoiceSchema,
  /** Seeds the project with a starter template's files first (#119). */
  templateId: z.enum(STARTER_TEMPLATE_IDS).optional(),
});

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const rateLimit = checkRateLimit(userId, CREATE_WITH_PROMPT_RATE_LIMIT);
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

  const { prompt, model, templateId } = data;
  const template = templateId ? getStarterTemplate(templateId) : undefined;

  if (detectCredential(prompt).detected) {
    return NextResponse.json(
      {
        error:
          "Credentials cannot be sent in a project prompt. Create the project first, then use Integrations.",
        code: "credential_detected",
      },
      { status: 422 },
    );
  }

  const { runModel, promoKind, rejected } = await requireModelChoice({
    internalKey,
    userId,
    model,
  });

  if (rejected) {
    return rejected;
  }

  // Before anything is created (ADR 0009).
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
    // Name it after its template, or generate a random name
    const projectName = template?.id ?? generateProjectName();

    // Create project and conversation together
    const { projectId, conversationId } = await convex.mutation(
      api.system.createProjectWithConversation,
      {
        internalKey,
        projectName,
        conversationTitle: DEFAULT_CONVERSATION_TITLE,
        ownerId: userId,
      },
    );

    if (template) {
      await seedTemplateFiles({ internalKey, projectId, template });
    }

    // Create user message
    await convex.mutation(api.system.createMessage, {
      internalKey,
      conversationId,
      projectId,
      role: "user",
      content: prompt,
    });

    // Create assistant message placeholder with processing status
    const assistantMessageId = await convex.mutation(
      api.system.createMessage,
      {
        internalKey,
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        status: "processing",
        runModel,
      },
    );

    // Trigger configured backend to process the message
    const dispatch = await dispatchProcessMessageOrFail({
      internalKey,
      messageId: assistantMessageId,
      conversationId,
      projectId,
      ownerId: userId,
      message: prompt,
      model: runModel,
    });

    // The project exists either way: return its id so the client can open it
    // and the user can retry from the chat.
    if (!dispatch) {
      // A retry from the chat takes its own run.
      await promoRun.refund();
      return NextResponse.json(
        { error: DISPATCH_FAILED_ERROR, code: "dispatch_failed", projectId },
        { status: 502 },
      );
    }

    return NextResponse.json({ projectId });
  } catch (error) {
    await promoRun.refund();
    throw error;
  }
};
