import { NextResponse } from "next/server";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";

interface OwnershipArgs {
  internalKey: string;
  userId: string;
}

type RequireOwnedResult<T> =
  | { found: T; notFound: undefined }
  | { found: undefined; notFound: NextResponse };

const notFoundResponse = (error: string) =>
  NextResponse.json({ error }, { status: 404 });

/**
 * Resolves a client-supplied project id for a route handler, but only when the
 * signed-in user owns the project. Missing, malformed and other users' ids all
 * get the same 404, so a caller cannot tell which projects exist (#208):
 *
 *   const { found: project, notFound } = await requireOwnedProject({ ... });
 *   if (notFound) return notFound;
 *
 * Call it before any Convex write, Inngest event or sandbox that uses the id:
 * the `api.system.*` functions behind those trust whatever id they are given.
 */
export const requireOwnedProject = async ({
  internalKey,
  userId,
  projectId,
}: OwnershipArgs & { projectId: string }): Promise<
  RequireOwnedResult<Doc<"projects">>
> => {
  const project = await convex.query(api.system.getOwnedProject, {
    internalKey,
    userId,
    projectId,
  });
  return project
    ? { found: project, notFound: undefined }
    : { found: undefined, notFound: notFoundResponse("Project not found") };
};

/** `requireOwnedProject` for a conversation, checked against its project's owner. */
export const requireOwnedConversation = async ({
  internalKey,
  userId,
  conversationId,
}: OwnershipArgs & { conversationId: string }): Promise<
  RequireOwnedResult<Doc<"conversations">>
> => {
  const conversation = await convex.query(api.system.getOwnedConversation, {
    internalKey,
    userId,
    conversationId,
  });
  return conversation
    ? { found: conversation, notFound: undefined }
    : { found: undefined, notFound: notFoundResponse("Conversation not found") };
};
