import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

/**
 * Copies a project's file tree into another project. Shared by project
 * duplication (`projects.duplicate`) and showcase imports
 * (`showcase.importToWorkspace`).
 */

/** Largest file tree copied in one transaction. */
export const MAX_COPY_FILES = 5000;

/**
 * Inserts a copy of every file and folder of `sourceId` into `targetId`,
 * keeping the tree shape. Binary files briefly share the source's storage
 * blob; `copyBlobs` then gives each copy its own, so deleting either project
 * never removes a blob the other still uses.
 */
export async function copyProjectFiles(
  ctx: MutationCtx,
  sourceId: Id<"projects">,
  targetId: Id<"projects">,
) {
  const sourceFiles = await ctx.db
    .query("files")
    .withIndex("by_project", (q) => q.eq("projectId", sourceId))
    .take(MAX_COPY_FILES + 1);

  if (sourceFiles.length > MAX_COPY_FILES) {
    throw new Error(
      `Projects with more than ${MAX_COPY_FILES} files can't be copied`,
    );
  }

  const now = Date.now();
  const idMap = new Map<Id<"files">, Id<"files">>();
  const binaryFileIds: Id<"files">[] = [];

  for (const file of sourceFiles) {
    const newFileId = await ctx.db.insert("files", {
      projectId: targetId,
      parentId: undefined,
      name: file.name,
      type: file.type,
      content: file.content,
      storageId: file.storageId,
      updatedAt: now,
    });
    idMap.set(file._id, newFileId);
    if (file.storageId) {
      binaryFileIds.push(newFileId);
    }
  }

  for (const file of sourceFiles) {
    if (file.parentId) {
      const newFileId = idMap.get(file._id);
      const newParentId = idMap.get(file.parentId);
      if (newFileId && newParentId) {
        await ctx.db.patch("files", newFileId, { parentId: newParentId });
      }
    }
  }

  if (binaryFileIds.length > 0) {
    await ctx.scheduler.runAfter(0, internal.projectCopy.copyBlobs, {
      fileIds: binaryFileIds,
    });
  }
}

/** Gives each copied binary file its own storage blob. */
export const copyBlobs = internalAction({
  args: { fileIds: v.array(v.id("files")) },
  handler: async (ctx, { fileIds }) => {
    for (const fileId of fileIds) {
      const storageId = await ctx.runQuery(internal.projectCopy.getStorageId, {
        fileId,
      });
      if (!storageId) continue;

      const blob = await ctx.storage.get(storageId);
      if (!blob) continue;

      const copyId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.projectCopy.swapStorageId, {
        fileId,
        from: storageId,
        to: copyId,
      });
    }
  },
});

export const getStorageId = internalQuery({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get("files", fileId);
    return file?.storageId ?? null;
  },
});

/**
 * Points the file at its own blob, unless it changed or was deleted while the
 * blob was being copied; then the unused copy is dropped instead.
 */
export const swapStorageId = internalMutation({
  args: {
    fileId: v.id("files"),
    from: v.id("_storage"),
    to: v.id("_storage"),
  },
  handler: async (ctx, { fileId, from, to }) => {
    const file = await ctx.db.get("files", fileId);
    if (file?.storageId === from) {
      await ctx.db.patch("files", fileId, { storageId: to });
    } else {
      await ctx.storage.delete(to);
    }
  },
});
