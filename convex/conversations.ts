import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";

import { verifyAuth } from "./auth";
import { withImageUrls } from "./chatImages";
import { appError } from "./errors";
import { getOwnedProject } from "./projects";

/** Newest conversations listed per project (#53). */
const MAX_CONVERSATIONS_LISTED = 200;

/** Newest messages shown in one conversation (#53). */
const MAX_MESSAGES_LISTED = 500;

/** The conversation, when `ownerId` owns its project. */
const getOwnedConversation = async (
  ctx: QueryCtx,
  id: Id<"conversations">,
  ownerId: string,
) => {
  const conversation = await ctx.db.get("conversations", id);
  // Conversations are only deleted with their project, so this reads as "gone".
  if (!conversation) {
    throw appError("NOT_FOUND", "Conversation not found");
  }
  await getOwnedProject(ctx, conversation.projectId, ownerId);
  return conversation;
};

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    const conversationId = await ctx.db.insert("conversations", {
      projectId: args.projectId,
      title: args.title,
      updatedAt: Date.now(),
    });

    return conversationId;
  },
});

export const getById = query({
  args: {
    id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    return await getOwnedConversation(ctx, args.id, identity.subject);
  },
});

export const getByProject = query({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    await getOwnedProject(ctx, args.projectId, identity.subject);

    return await ctx.db
      .query("conversations")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(MAX_CONVERSATIONS_LISTED);
  },
});

export const getMessages = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    await getOwnedConversation(ctx, args.conversationId, identity.subject);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .take(MAX_MESSAGES_LISTED);

    return await withImageUrls(ctx, messages.reverse());
  },
});

/**
 * The project's in-flight agent run, or null when none is running. The preview
 * reads it to hold off booting a sandbox while the first build is still being
 * written. `firstBuild`: no run in the project has completed yet, which still
 * holds for a project seeded with the starter at creation (#338).
 */
export const getActiveRun = query({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    await getOwnedProject(ctx, args.projectId, identity.subject);

    const message = await ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "processing")
      )
      .order("desc")
      .first();

    if (!message) return null;

    const completed = await ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "completed")
      )
      .first();

    return { steps: message.steps ?? [], firstBuild: completed === null };
  },
});
