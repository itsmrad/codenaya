import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import { convex } from "@/lib/convex-client";
import { cancelProcessingMessage } from "@/lib/message-processor";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  projectId: z.string(),
});

export async function POST(request: Request) {
  const { unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }
  
  const body = await request.json();
  const { projectId } = requestSchema.parse(body);

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Internal key not configured" },
      { status: 500 }
    );
  }

  // Find all processing messages in this project
  const processingMessages = await convex.query(
    api.system.getProcessingMessages,
    {
      internalKey,
      projectId: projectId as Id<"projects">,
    }
  );

  if (processingMessages.length === 0) {
    return NextResponse.json({ success: true, cancelled: false });
  }

  // Cancel all processing messages
  const cancelledIds = await Promise.all(
    processingMessages.map(async (msg) => {
      await cancelProcessingMessage({ internalKey, messageId: msg._id });

      return msg._id;
    })
  );

  return NextResponse.json({
    success: true,
    cancelled: true,
    messageIds: cancelledIds,
  });
};
