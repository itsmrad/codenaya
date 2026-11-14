import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";

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

  const { data, invalid } = await parseJsonBody(request, requestSchema);

  if (invalid) {
    return invalid;
  }

  const { projectId, repoName, visibility, description } = data;

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

  // A linked project pushes to its repo instead of making another (#343).
  if (project.githubSync) {
    return NextResponse.json(
      { error: "This project is already linked to a GitHub repository" },
      { status: 409 }
    );
  }

  // Checked here for a clear error; the job looks the token up itself (#211).
  if (!(await getGithubToken(userId))) {
    return githubNotLinkedResponse();
  }

  const event = await inngest.send({
    name: "github/export.repo",
    data: {
      projectId: project._id,
      repoName,
      visibility,
      description,
      userId,
    },
  });

  return NextResponse.json({ 
    success: true, 
    projectId, 
    eventId: event.ids[0]
  });
};
