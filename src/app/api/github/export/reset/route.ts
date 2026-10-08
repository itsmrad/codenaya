import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import { convex } from "@/lib/convex-client";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";

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

  // Clear export status
  await convex.mutation(api.system.updateExportStatus, {
    internalKey,
    projectId: project._id,
    status: undefined,
    repoUrl: undefined,
  });

  return NextResponse.json({ 
    success: true, 
    projectId, 
  });
};
