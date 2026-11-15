import type { TextMessage } from "@inngest/agent-kit";

import { AGENT_FAILURE_MESSAGE, isFailedRunReply } from "../../failed-run-reply";

export { AGENT_FAILURE_MESSAGE };

/** Stored when a run finishes without an assistant text response. */
export const DEFAULT_REPLY_MESSAGE =
  "I processed your request. Let me know if you need anything else!";

/** Stands in for the reply of an earlier request that was stopped or failed. */
export const UNFINISHED_REPLY = "(This request was stopped or failed before it finished; no reply was given.)";

/** A message as `system.getRecentMessages` returns it. */
interface StoredMessage {
  _id: string;
  role: "user" | "assistant";
  content: string;
  status?: "processing" | "completed" | "cancelled";
}

const usableReply = ({ role, status, content }: StoredMessage) =>
  role === "assistant" &&
  (status ?? "completed") === "completed" &&
  content.trim() !== "" &&
  !isFailedRunReply(content);

/**
 * The conversation before the request this run answers, as chat messages,
 * oldest first: each user message with the reply it got. A reply that was
 * cancelled, failed, or is still running becomes UNFINISHED_REPLY: the request
 * is kept (a "continue" after a stopped first build needs it), but the model
 * never reads failure text as its own answer. Attached images are not resent.
 */
export function priorTurns(
  messages: readonly StoredMessage[],
  currentMessageId: string,
): TextMessage[] {
  const end = messages.findIndex((msg) => msg._id === currentMessageId);
  const earlier = end === -1 ? messages : messages.slice(0, end);
  // The last user message is the request itself, which the run sends separately.
  const before = earlier.slice(0, earlier.findLastIndex((msg) => msg.role === "user"));

  return before.flatMap((asked, i): TextMessage[] => {
    if (asked.role !== "user") return [];
    const reply = before[i + 1];
    return [
      { type: "text", role: "user", content: asked.content.trim() || "(images only)" },
      { type: "text", role: "assistant", content: reply && usableReply(reply) ? reply.content : UNFINISHED_REPLY },
    ];
  });
}
