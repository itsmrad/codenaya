import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { AGENT_FAILURE_MESSAGE, LOST_RUN_MESSAGE } from "./agent-steps";

/** One message typed during a run, sent when that run ends (#257). Client-side only. */
export interface FollowUp {
  projectId: string;
  text: string;
  /** The assistant message of the run it waits for. */
  afterMessageId: Id<"messages">;
}

type RunMessage = Pick<Doc<"messages">, "_id" | "status" | "content" | "stuck">;

/**
 * What to do with `followUp` given the open conversation's messages: wait for
 * its run (also while that conversation isn't open), send it once the run
 * completed, or drop it when the run was stopped or failed, since the next
 * request may no longer make sense.
 * shortcut: a run that failed on the user's key reads as completed; add its
 * reply here if that matters.
 */
export function followUpAction(
  followUp: FollowUp,
  messages: readonly RunMessage[] | undefined,
): "wait" | "send" | "drop" {
  const run = messages?.find((message) => message._id === followUp.afterMessageId);
  if (!run || run.status === "processing") return "wait";
  const failed =
    run.status === "cancelled" ||
    Boolean(run.stuck) ||
    run.content === AGENT_FAILURE_MESSAGE ||
    run.content === LOST_RUN_MESSAGE;
  return failed ? "drop" : "send";
}
