import type { TextMessage } from "@inngest/agent-kit";

import { LOST_RUN_MESSAGE } from "../../agent-steps";
import { KEY_FAILURE_SUFFIX } from "@/features/ai-providers/server/resolve-run-model";

/** The reply `processMessage` stores when a run fails. */
export const AGENT_FAILURE_MESSAGE =
  "My apologies, I encountered an error while processing your request. Let me know if you need anything else!";

/** A message as `system.getRecentMessages` returns it. */
interface StoredMessage {
  _id: string;
  role: "user" | "assistant";
  content: string;
  status?: "processing" | "completed" | "cancelled";
}

const isFailedRunReply = (content: string) =>
  content === AGENT_FAILURE_MESSAGE ||
  content === LOST_RUN_MESSAGE ||
  content.endsWith(KEY_FAILURE_SUFFIX);

const usableReply = ({ role, status, content }: StoredMessage) =>
  role === "assistant" &&
  (status ?? "completed") === "completed" &&
  content.trim() !== "" &&
  !isFailedRunReply(content);

/**
 * The conversation before the request this run answers, as chat messages,
 * oldest first: each user message with the reply it got. A turn that was
 * cancelled, failed, or is still running is left out whole, so the model never
 * reads failure text as its own answer. Attached images are not resent.
 */
export function priorTurns(
  messages: readonly StoredMessage[],
  currentMessageId: string,
): TextMessage[] {
  const end = messages.findIndex((msg) => msg._id === currentMessageId);
  const earlier = end === -1 ? messages : messages.slice(0, end);

  return earlier.flatMap((reply, i): TextMessage[] => {
    const asked = earlier[i - 1];
    if (asked?.role !== "user" || !usableReply(reply)) return [];
    return [
      { type: "text", role: "user", content: asked.content.trim() || "(images only)" },
      { type: "text", role: "assistant", content: reply.content },
    ];
  });
}
