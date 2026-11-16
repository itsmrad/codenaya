import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { appError } from "./errors";

/** Read in the file-write transaction, so cancellation and writes serialize. */
export async function assertRunWriting(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  messageId?: Id<"messages">,
) {
  // Non-run callers (imports and repairs) do not have a message.
  if (!messageId) return;
  const message = await ctx.db.get("messages", messageId);
  if (!message || message.projectId !== projectId || message.status !== "processing") {
    throw appError("CONFLICT", "This run has stopped writing");
  }
}
