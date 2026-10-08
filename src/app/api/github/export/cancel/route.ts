import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import { convex } from "@/lib/convex-client";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";
import { inngest } from "@/inngest/client";

import { api } from "../../../../../../convex/_generated/api";

const requestSchema = z.object({
  projectId: z.string(),
});

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json();
  const { projectId } = requestSchema.parse(body);

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Server configuration error" },
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

  const event = await inngest.send({
    name: "github/export.cancel",
    data: {
      projectId: project._id,
    },
  });

  // Update status to cancelled
  await convex.mutation(api.system.updateExportStatus, {
    internalKey,
    projectId: project._id,
    status: "cancelled",
  });

  return NextResponse.json({ 
    success: true, 
    projectId, 
    eventId: event.ids[0]
  });
};
