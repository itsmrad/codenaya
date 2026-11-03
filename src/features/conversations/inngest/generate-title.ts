import { createAgent } from "@inngest/agent-kit";
import type { GetStepTools } from "inngest";

import type { RunModel } from "@/features/ai-providers/server/resolve-run-model";
import type { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { TITLE_GENERATOR_SYSTEM_PROMPT } from "./constants";

/**
 * Names the conversation after the request. Runs alongside the coding agent,
 * so it never throws: a failed title keeps the default, and the coding agent
 * reports a rejected key itself (#338).
 */
export const generateConversationTitle = async ({
  step,
  runModel,
  request,
  recordUsage,
  internalKey,
  conversationId,
}: {
  step: GetStepTools<typeof inngest>;
  runModel: RunModel;
  request: string;
  recordUsage: (raw: string | undefined) => Promise<void>;
  internalKey: string;
  conversationId: Id<"conversations">;
}) => {
  try {
    const titleAgent = createAgent({
      name: "title-generator",
      system: TITLE_GENERATOR_SYSTEM_PROMPT,
      model: runModel.title(0),
    });
    const { output, raw } = await titleAgent.run(request, { step });
    await recordUsage(raw);

    const textMessage = output.find((m) => m.type === "text" && m.role === "assistant");
    if (textMessage?.type !== "text") return;
    const title =
      typeof textMessage.content === "string"
        ? textMessage.content.trim()
        : textMessage.content.map((c) => c.text).join("").trim();

    if (title) {
      await step.run("update-conversation-title", async () => {
        await convex.mutation(api.system.updateConversationTitle, {
          internalKey,
          conversationId,
          title,
        });
      });
    }
  } catch (error) {
    console.error("[process-message] title generation failed", error);
  }
};
