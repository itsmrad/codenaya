import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { isFailedRunReply } from "./failed-run-reply";
import type { MessageMode } from "./plan-mode";

/** One message typed during a run, sent when that run ends (#257). Client-side only. */
export interface FollowUp {
  text: string;
  /** The assistant message of the run it waits for. */
  afterMessageId: Id<"messages">;
  /** The composer's mode when it was queued (none for Build). */
  mode?: MessageMode;
}

type RunMessage = Pick<Doc<"messages">, "_id" | "status" | "content" | "stuck">;

/**
 * What to do with `followUp` given its conversation's messages: wait for its
 * run, send it once the run completed and the chat is free (`busy`: a send in
 * flight, another run, a message queued from outside the chat), or drop it
 * when the run was stopped or failed, since the next request may no longer
 * make sense. A stalled run (`stalledRunId`, silent too long but not stuck)
 * counts as ended: the composer could send over it, and the send stops it.
 */
export function followUpAction(
  followUp: FollowUp,
  messages: readonly RunMessage[] | undefined,
  busy = false,
  stalledRunId?: Id<"messages">,
): "wait" | "send" | "drop" {
  const run = messages?.find((message) => message._id === followUp.afterMessageId);
  if (!run || (run.status === "processing" && run._id !== stalledRunId)) return "wait";
  const failed = run.status === "cancelled" || Boolean(run.stuck) || isFailedRunReply(run.content);
  if (failed) return "drop";
  return busy ? "wait" : "send";
}

/**
 * What a composer submit (Enter or the Send/Queue button) does. During a run
 * it only ever queues: stopping is the Stop button's or Esc's job, so a stray
 * Enter in an empty composer never cancels the run.
 */
export function composerSubmitAction({
  running,
  text,
  hasImages,
  hasFollowUp,
}: {
  running: boolean;
  text: string;
  hasImages: boolean;
  hasFollowUp: boolean;
}): "send" | "queue" | "ignore" | "already-queued" | "images-not-queued" {
  if (!running) return "send";
  if (!text.trim()) return "ignore";
  if (hasImages) return "images-not-queued";
  return hasFollowUp ? "already-queued" : "queue";
}
