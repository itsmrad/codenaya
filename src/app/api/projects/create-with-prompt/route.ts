import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  adjectives,
  animals,
  colors,
  uniqueNamesGenerator,
} from "unique-names-generator";

import { DEFAULT_CONVERSATION_TITLE } from "@/features/conversations/constants";

import { convex } from "@/lib/convex-client";
import { dispatchProcessMessage } from "@/lib/message-processor";

import { api } from "../../../../../convex/_generated/api";

const requestSchema = z.object({
  prompt: z.string().min(1),
  projectName: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

    if (!internalKey) {
      return NextResponse.json(
        { error: "Internal key not configured" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { prompt, projectName: customProjectName } = requestSchema.parse(body);

    // Generate a project name if not specified
    const projectName =
      customProjectName?.trim() ||
      uniqueNamesGenerator({
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
        initialPrompt: prompt,
      },
    );

    // Create initial messages (non-blocking for workspace launch)
    try {
      await convex.mutation(api.system.createMessage, {
        internalKey,
        conversationId,
        projectId,
        role: "user",
        content: prompt,
      });

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

      // Trigger background processing if available
      try {
        await dispatchProcessMessage({
          internalKey,
          messageId: assistantMessageId,
          conversationId,
          projectId,
          message: prompt,
        });
      } catch (inngestErr) {
        console.warn("[create-with-prompt] Background message processing skipped:", inngestErr);
      }
    } catch (msgErr) {
      console.warn("[create-with-prompt] Message creation warning:", msgErr);
    }

    return NextResponse.json({ projectId });
  } catch (error: unknown) {
    console.error("[create-with-prompt] Error creating workspace:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
