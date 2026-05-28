import { getRun, start } from "workflow/api";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

import {
  processMessageWorkflow,
  type ProcessMessageInput,
} from "./process-message.workflow";

/**
 * Starts the durable workflow that processes a user message and persists the
 * resulting workflow run id on the assistant message so it can be cancelled
 * later via Convex lookup.
 */
export async function startProcessMessageWorkflow(input: ProcessMessageInput) {
  const run = await start(processMessageWorkflow, [input]);

  try {
    await convex.mutation(api.system.setMessageWorkflowRunId, {
      internalKey: input.internalKey,
      messageId: input.messageId,
      workflowRunId: run.runId,
    });
  } catch (persistErr) {
    // We have a live workflow run with no way for the rest of the system to
    // reach it (cancel, observe, etc.). Best-effort: tear it down so we don't
    // leak compute, then surface the persistence failure to the caller.
    try {
      const startedRun = getRun(run.runId);
      await startedRun.cancel();
      console.warn(
        "[workflow] cancelled orphan run after persistence failure",
        run.runId
      );
    } catch (cancelErr) {
      console.warn(
        "[workflow] failed to cancel orphan run",
        run.runId,
        cancelErr
      );
    }
    throw persistErr;
  }

  return run.runId;
}

/**
 * Cancels a workflow run for a given assistant message id. No-op when the
 * message has no associated workflow run (e.g. it was processed via Inngest).
 */
export async function cancelProcessMessageWorkflowByMessageId(opts: {
  internalKey: string;
  messageId: Id<"messages">;
}) {
  const message = await convex.query(api.system.getMessageById, {
    internalKey: opts.internalKey,
    messageId: opts.messageId,
  });

  if (!message?.workflowRunId) {
    return false;
  }

  try {
    const run = getRun(message.workflowRunId);
    await run.cancel();
    return true;
  } catch (err) {
    // Run may already be completed or missing. Treat as a non-fatal cancel.
    console.warn(
      "[workflow] cancel failed for run",
      message.workflowRunId,
      err
    );
    return false;
  }
}
