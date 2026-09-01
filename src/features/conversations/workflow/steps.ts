import { generateText } from "ai";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

import { vertexModel, VERTEX_MODELS } from "./lib/vertex-model";
import { TITLE_GENERATOR_SYSTEM_PROMPT } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// Convex steps
// Each step is durable and retryable. They are intentionally narrow — the
// workflow function orchestrates them.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationContext {
  conversation: {
    _id: Id<"conversations">;
    title: string;
    projectId: Id<"projects">;
  };
  contextMessages: Array<{
    _id: Id<"messages">;
    role: "user" | "assistant";
    content: string;
  }>;
}

export async function loadConversationContext(opts: {
  internalKey: string;
  conversationId: Id<"conversations">;
  excludeMessageId: Id<"messages">;
}): Promise<ConversationContext | null> {
  "use step";

  const conversation = await convex.query(api.system.getConversationById, {
    internalKey: opts.internalKey,
    conversationId: opts.conversationId,
  });

  if (!conversation) {
    return null;
  }

  const recent = await convex.query(api.system.getRecentMessages, {
    internalKey: opts.internalKey,
    conversationId: opts.conversationId,
    limit: 10,
  });

  const filtered = recent
    .filter((msg) => msg._id !== opts.excludeMessageId && msg.content.trim() !== "")
    .map((msg) => ({
      _id: msg._id,
      role: msg.role,
      content: msg.content,
    }));

  return {
    conversation: {
      _id: conversation._id,
      title: conversation.title,
      projectId: conversation.projectId,
    },
    contextMessages: filtered,
  };
}

export async function generateConversationTitle(opts: {
  message: string;
}): Promise<string | null> {
  "use step";

  try {
    const { text } = await generateText({
      model: vertexModel(VERTEX_MODELS.title),
      system: TITLE_GENERATOR_SYSTEM_PROMPT,
      prompt: opts.message,
      temperature: 0,
    });

    const cleaned = text.trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

export async function persistConversationTitle(opts: {
  internalKey: string;
  conversationId: Id<"conversations">;
  title: string;
}) {
  "use step";

  await convex.mutation(api.system.updateConversationTitle, {
    internalKey: opts.internalKey,
    conversationId: opts.conversationId,
    title: opts.title,
  });
}

export async function persistAssistantMessage(opts: {
  internalKey: string;
  messageId: Id<"messages">;
  content: string;
}) {
  "use step";

  await convex.mutation(api.system.updateMessageContent, {
    internalKey: opts.internalKey,
    messageId: opts.messageId,
    content: opts.content,
  });
}

export async function markMessageCancelled(opts: {
  internalKey: string;
  messageId: Id<"messages">;
}) {
  "use step";

  await convex.mutation(api.system.updateMessageStatus, {
    internalKey: opts.internalKey,
    messageId: opts.messageId,
    status: "cancelled",
  });
}

export async function markMessageFailed(opts: {
  internalKey: string;
  messageId: Id<"messages">;
}) {
  "use step";

  await convex.mutation(api.system.updateMessageContent, {
    internalKey: opts.internalKey,
    messageId: opts.messageId,
    content:
      "My apologies, I encountered an error while processing your request. Let me know if you need anything else!",
  });
}
