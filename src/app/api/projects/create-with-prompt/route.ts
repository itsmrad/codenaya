import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import {
  adjectives,
  animals,
  colors,
  uniqueNamesGenerator,
} from "unique-names-generator";

import { DEFAULT_CONVERSATION_TITLE } from "@/features/conversations/constants";

import { convex } from "@/lib/convex-client";
import {
  DISPATCH_FAILED_ERROR,
  dispatchProcessMessageOrFail,
} from "@/lib/message-processor";
import { detectCredential } from "@/features/integrations/credential-guard";

import { api } from "../../../../../convex/_generated/api";

const requestSchema = z.object({
  prompt: z.string().min(1),
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
  const { prompt } = requestSchema.parse(body);

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

  // Generate a random project name
  const projectName = uniqueNamesGenerator({
    dictionaries: [adjectives, animals, colors],
    separator: "-",
    length: 3,
  });

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
    },
  );

  // Trigger configured backend to process the message
  const dispatch = await dispatchProcessMessageOrFail({
    internalKey,
    messageId: assistantMessageId,
    conversationId,
    projectId,
    message: prompt,
  });

  // The project exists either way: return its id so the client can open it
  // and the user can retry from the chat.
  if (!dispatch) {
    return NextResponse.json(
      { error: DISPATCH_FAILED_ERROR, code: "dispatch_failed", projectId },
      { status: 502 },
    );
  }

  return NextResponse.json({ projectId });
};
