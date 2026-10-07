import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { inngest } from "@/inngest/client";
import {
  getGithubToken,
  githubNotLinkedResponse,
} from "@/features/projects/server/github-token";

import { Id } from "../../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  projectId: z.string(),
  repoName: z.string().min(1).max(100),
  visibility: z.enum(["public", "private"]).default("private"),
  description: z.string().max(350).optional(),
});

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { projectId, repoName, visibility, description } = requestSchema.parse(body);

  const githubToken = await getGithubToken(userId);

  if (!githubToken) {
    return githubNotLinkedResponse();
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const event = await inngest.send({
    name: "github/export.repo",
    data: {
      projectId,
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
