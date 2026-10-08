import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import {
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGE_BYTES,
  isChatImageType,
} from "../src/features/conversations/chat-images";

/**
 * Images attached in the chat composer. The browser uploads each one straight
 * to Convex storage, then registers it here against the project; a message can
 * only reference images its sender registered on that project.
 */

const requireOwnedProject = async (
  ctx: MutationCtx,
  projectId: Id<"projects">,
) => {
  const identity = await verifyAuth(ctx);
  const project = await ctx.db.get("projects", projectId);

  if (!project) {
    throw new Error("Project not found");
  }

  if (project.ownerId !== identity.subject) {
    throw new Error("Unauthorized to access this project");
  }

  return project;
};

export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.projectId);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Claims an uploaded blob for the caller. A blob that is not an allowed image
 * is deleted and the reason returned: throwing would roll the delete back.
 */
export const register = mutation({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const project = await requireOwnedProject(ctx, args.projectId);

    const claimed = await ctx.db
      .query("chatImages")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (claimed) {
      throw new Error("Image already registered");
    }

    const file = await ctx.db.system.get("_storage", args.storageId);
    if (!file) {
      throw new Error("Upload not found");
    }

    if (!isChatImageType(file.contentType) || file.size > MAX_CHAT_IMAGE_BYTES) {
      await ctx.storage.delete(args.storageId);
      return `Images must be PNG, JPEG, WebP or GIF, up to ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MB`;
    }

    await ctx.db.insert("chatImages", {
      storageId: args.storageId,
      projectId: args.projectId,
      ownerId: project.ownerId,
    });
    return null;
  },
});

/** Throws unless every image was registered by `ownerId` on `projectId`. */
export const assertOwnedImages = async (
  ctx: MutationCtx,
  images: Id<"_storage">[],
  { projectId, ownerId }: { projectId: Id<"projects">; ownerId?: string },
) => {
  if (images.length > MAX_CHAT_IMAGES) {
    throw new Error(`At most ${MAX_CHAT_IMAGES} images per message`);
  }

  for (const storageId of images) {
    const image = await ctx.db
      .query("chatImages")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .unique();
    if (!image || image.projectId !== projectId || image.ownerId !== ownerId) {
      throw new Error("Image not found");
    }
  }
};

/** Adds `imageUrls` to messages that carry images. */
export const withImageUrls = async (
  ctx: QueryCtx,
  messages: Doc<"messages">[],
): Promise<(Doc<"messages"> & { imageUrls?: string[] })[]> =>
  await Promise.all(
    messages.map(async (message) => {
      if (!message.images?.length) return message;
      const urls = await Promise.all(
        message.images.map((storageId) => ctx.storage.getUrl(storageId)),
      );
      return {
        ...message,
        imageUrls: urls.filter((url): url is string => url !== null),
      };
    }),
  );
