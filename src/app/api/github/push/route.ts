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
});

/** POST /api/github/push: pushes the project's changes to its linked repo (#343). */
export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const { data, invalid } = await parseJsonBody(request, requestSchema);

  if (invalid) {
    return invalid;
  }

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
    projectId: data.projectId,
  });

  if (notFound) {
    return notFound;
  }

  if (!project.githubSync) {
    return NextResponse.json(
      { error: "Export this project to GitHub first" },
      { status: 400 }
    );
  }

  // Checked here for a clear error; the job looks the token up itself (#211).
  if (!(await getGithubToken(userId))) {
    return githubNotLinkedResponse();
  }

  const event = await inngest.send({
    name: "github/sync.push",
    data: { projectId: project._id, userId },
  });

  return NextResponse.json({ success: true, eventId: event.ids[0] });
}
