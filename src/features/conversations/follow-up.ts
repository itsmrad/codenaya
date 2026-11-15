import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { isFailedRunReply } from "./failed-run-reply";

/** One message typed during a run, sent when that run ends (#257). Client-side only. */
export interface FollowUp {
  text: string;
  /** The assistant message of the run it waits for. */
  afterMessageId: Id<"messages">;
}

type RunMessage = Pick<Doc<"messages">, "_id" | "status" | "content" | "stuck">;

/**
 * What to do with `followUp` given its conversation's messages: wait for its
 * run, send it once the run completed, or drop it when the run was stopped or
 * failed, since the next request may no longer make sense.
 */
export function followUpAction(
  followUp: FollowUp,
  messages: readonly RunMessage[] | undefined,
): "wait" | "send" | "drop" {
  const run = messages?.find((message) => message._id === followUp.afterMessageId);
  if (!run || run.status === "processing") return "wait";
  const failed = run.status === "cancelled" || Boolean(run.stuck) || isFailedRunReply(run.content);
  return failed ? "drop" : "send";
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
