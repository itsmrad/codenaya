import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";

import { convex } from "@/lib/convex-client";
import { cancelProcessingMessage } from "@/lib/message-processor";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";

import { api } from "../../../../../convex/_generated/api";

const requestSchema = z.object({
  projectId: z.string(),
  undo: z.boolean().optional(),
  messageId: z.string().optional(),
  // What stopped the run, for diagnosing unintended cancels (#608).
  source: z.enum(["esc", "button"]).optional(),
});

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }
  
  const { data, invalid } = await parseJsonBody(request, requestSchema);

  if (invalid) {
    return invalid;
  }

  const { projectId, source, undo, messageId } = data;

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Internal key not configured" },
      { status: 500 }
    );
  }

  const { found: project, notFound } = await requireOwnedProject({
    internalKey,
    userId,
    projectId,
  });

  if (notFound) {
    return notFound;
  }

  // Find all processing messages in this project
  const processingMessages = await convex.query(
    api.system.getProcessingMessages,
    {
      internalKey,
      projectId: project._id,
    }
  );

  console.info("Run cancel requested", {
    projectId: project._id,
    source: source ?? "unknown",
    messageIds: processingMessages.map((msg) => msg._id),
  });

  if (processingMessages.length === 0) {
    return NextResponse.json({ success: true, cancelled: false });
  }

  // An undo targets the displayed run, never a newer run that raced the click.
  const undoMessage = undo ? processingMessages.find((msg) => msg._id === messageId) : undefined;
  if (undo && !undoMessage) {
    return NextResponse.json({ error: "The run is no longer processing" }, { status: 409 });
  }

  // Cancel all processing messages
  const cancelledIds = await Promise.all(
    processingMessages.map(async (msg) => {
      await cancelProcessingMessage({ internalKey, messageId: msg._id });

      return msg._id;
    })
  );

  const undoCheckpointId = undoMessage
    ? await convex.mutation(api.checkpoints.restoreStoppedRun, {
        internalKey,
        ownerId: userId,
        messageId: undoMessage._id,
      })
    : null;

  return NextResponse.json({
    undoCheckpointId,
    success: true,
    cancelled: true,
    messageIds: cancelledIds,
  });
};
