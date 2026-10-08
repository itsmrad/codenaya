import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";

import { inngest } from "@/inngest/client";
import {
  getGithubToken,
  githubNotLinkedResponse,
} from "@/features/projects/server/github-token";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";

const requestSchema = z.object({
  projectId: z.string(),
  repoName: z.string().min(1).max(100),
  visibility: z.enum(["public", "private"]).default("private"),
  description: z.string().max(350).optional(),
});

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const body = await request.json();
  const { projectId, repoName, visibility, description } = requestSchema.parse(body);

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

  const githubToken = await getGithubToken(userId);

  if (!githubToken) {
    return githubNotLinkedResponse();
  }

  const event = await inngest.send({
    name: "github/export.repo",
    data: {
      projectId: project._id,
      repoName,
      visibility,
      description,
      githubToken,
      internalKey,
    },
  });

  return NextResponse.json({ 
    success: true, 
    projectId, 
    eventId: event.ids[0]
  });
};
