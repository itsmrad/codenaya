import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import type { ModelMessage, UIMessageChunk } from "ai";

import { Id } from "../../../../convex/_generated/dataModel";

import { CODING_AGENT_SYSTEM_PROMPT, WORKFLOW_MAX_STEPS } from "./constants";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { vertex, VERTEX_MODELS } from "./lib/vertex-model";
import { createCodingTools } from "./tools";
import {
  generateConversationTitle,
  loadConversationContext,
  markMessageFailed,
  persistAssistantMessage,
  persistConversationTitle,
} from "./steps";

export interface ProcessMessageInput {
  internalKey: string;
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
}

/**
 * Durable workflow that processes a user message: generates a title (if needed),
 * runs the coding agent loop with file tools, and persists the assistant
 * response. Mirrors the Inngest `processMessage` function so either backend
 * can be selected via the `MESSAGE_PROCESSOR` env flag.
 *
 * Tool calls inside the agent loop are executed as durable steps with
 * automatic retries. The function suspends across step boundaries, so the
 * full agent loop survives crashes and deploys.
 */
export async function processMessageWorkflow(input: ProcessMessageInput) {
  "use workflow";

  const {
    internalKey,
    messageId,
    conversationId,
    projectId,
    message,
  } = input;

  try {
    // 1. Load conversation context (history + conversation row)
    const ctx = await loadConversationContext({
      internalKey,
      conversationId,
      excludeMessageId: messageId,
    });

    if (!ctx) {
      // Conversation was deleted before we got here — nothing to do.
      return { success: false as const, reason: "conversation-not-found" };
    }

    // 2. Title generation (only when still default)
    if (ctx.conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const title = await generateConversationTitle({ message });
      if (title) {
        await persistConversationTitle({
          internalKey,
          conversationId,
          title,
        });
      }
    }

    // 3. Build system prompt with conversation history.
    let systemPrompt = CODING_AGENT_SYSTEM_PROMPT;
    if (ctx.contextMessages.length > 0) {
      const historyText = ctx.contextMessages
        .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");
      systemPrompt += `\n\n## Previous Conversation (for context only - do NOT repeat these responses):\n${historyText}\n\n## Current Request:\nRespond ONLY to the user's new message below. Do not repeat or reference your previous responses.`;
    }

    // Tools occasionally return a string starting with "Error: ... failed
    // transiently". This means a Convex/network call exhausted its automatic
    // retries inside a durable step. The tool itself is still healthy — call
    // it again on a later turn rather than telling the user the system is
    // broken.
    systemPrompt +=
      `\n\n## Tool error handling:\nIf a tool returns a string starting with "Error: <toolName> failed transiently", treat it as a temporary infrastructure hiccup. You may retry the same tool call on your next turn. Do NOT tell the user that file system tools are unavailable.`;

    // 4. Run the durable agent against Gemini 3.1 Pro Preview on Vertex AI.
    const agent = new DurableAgent({
      model: async () => {
        "use step";
        return vertex(VERTEX_MODELS.coding);
      },
      instructions: systemPrompt,
      temperature: 0.3,
      tools: createCodingTools({ internalKey, projectId }),
    });

    const messages: ModelMessage[] = [{ role: "user", content: message }];

    const writable = getWritable<UIMessageChunk>();

    const result = await agent.stream({
      messages,
      writable,
      maxSteps: WORKFLOW_MAX_STEPS,
    });

    // 5. Extract the final assistant text from the resulting messages
    const lastAssistantMessage = [...result.messages]
      .reverse()
      .find((m) => m.role === "assistant");

    let assistantText =
      "I processed your request. Let me know if you need anything else!";

    if (lastAssistantMessage) {
      const content = lastAssistantMessage.content;
      if (typeof content === "string") {
        if (content.trim().length > 0) {
          assistantText = content;
        }
      } else if (Array.isArray(content)) {
        const text = content
          .filter((part): part is { type: "text"; text: string } =>
            part.type === "text"
          )
          .map((part) => part.text)
          .join("");
        if (text.trim().length > 0) {
          assistantText = text;
        }
      }
    }

    // 6. Persist the assistant response (also flips status to completed)
    await persistAssistantMessage({
      internalKey,
      messageId,
      content: assistantText,
    });

    return { success: true as const, messageId, conversationId };
  } catch (originalErr) {
    // Best-effort failure write — mirrors the Inngest onFailure handler.
    // Wrapped in its own try/catch so a markMessageFailed throw cannot
    // mask the real root cause we're rethrowing below.
    try {
      await markMessageFailed({ internalKey, messageId });
    } catch (markErr) {
      console.warn(
        "[workflow] markMessageFailed threw while handling original error",
        markErr
      );
    }
    throw originalErr;
  }
}
