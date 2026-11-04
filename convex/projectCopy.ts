import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { appError } from "./errors";
import { insertFileContent, withContents } from "./fileContents";
import { releaseStorageIfUnreferenced } from "./projectCascade";

/**
 * Copies a project's file tree into another project. Shared by project
 * duplication (`projects.duplicate`) and showcase imports
 * (`showcase.importToWorkspace`).
 */

/** Largest file tree copied in one transaction. */
export const MAX_COPY_FILES = 5000;

/**
 * Inserts a copy of every file and folder of `sourceId` into `targetId`,
 * keeping the tree shape. Binary files share the source's storage blob until
 * `copyBlobs` gives each copy its own. Blob deletes are reference-checked
 * (`releaseStorageIfUnreferenced`), so deleting either side meanwhile, or a
 * `copyBlobs` run that never finishes, can't remove a blob the other uses.
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
    throw appError(
      "LIMIT_EXCEEDED",
      `Projects with more than ${MAX_COPY_FILES} files can't be copied`,
    );
  }

  const now = Date.now();
  const idMap = new Map<Id<"files">, Id<"files">>();
  const binaryFileIds: Id<"files">[] = [];

  // ponytail: 5,000 files write up to 15k docs (file, content row, parent
  // patch) of the 16k per transaction; insert parents first to drop the patch
  // pass if MAX_COPY_FILES ever rises.
  for (const file of await withContents(ctx, sourceId, sourceFiles)) {
    const newFileId = await ctx.db.insert("files", {
      projectId: targetId,
      parentId: undefined,
      name: file.name,
      type: file.type,
      storageId: file.storageId,
      updatedAt: now,
    });
    if (file.content !== undefined) {
      await insertFileContent(ctx, newFileId, targetId, file.content);
    }
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

/** Files handled per query and per mutation in `copyBlobs`. */
const COPY_BLOBS_BATCH_SIZE = 100;

/**
 * Gives each copied binary file its own storage blob. Batched, so a large
 * copy costs two function calls per batch instead of two per file (#212).
 */
export const copyBlobs = internalAction({
  args: { fileIds: v.array(v.id("files")) },
  handler: async (ctx, { fileIds }) => {
    for (let i = 0; i < fileIds.length; i += COPY_BLOBS_BATCH_SIZE) {
      const files = await ctx.runQuery(internal.projectCopy.getStorageIds, {
        fileIds: fileIds.slice(i, i + COPY_BLOBS_BATCH_SIZE),
      });

      const swaps = [];
      for (const { fileId, storageId } of files) {
        const blob = await ctx.storage.get(storageId);
        if (!blob) continue;
        swaps.push({ fileId, from: storageId, to: await ctx.storage.store(blob) });
      }

      if (swaps.length > 0) {
        await ctx.runMutation(internal.projectCopy.swapStorageIds, { swaps });
      }
    }
  },
});

/** The current blob of each file that still has one. */
export const getStorageIds = internalQuery({
  args: { fileIds: v.array(v.id("files")) },
  returns: v.array(
    v.object({ fileId: v.id("files"), storageId: v.id("_storage") }),
  ),
  handler: async (ctx, { fileIds }) => {
    const files = await Promise.all(
      fileIds.map((fileId) => ctx.db.get("files", fileId)),
    );
    return files.flatMap((file) =>
      file?.storageId ? [{ fileId: file._id, storageId: file.storageId }] : [],
    );
  },
});

/**
 * Points each file at its own blob, unless it changed or was deleted while the
 * blob was being copied; then the unused copy is dropped instead. The old blob
 * is freed if nothing else uses it any more (the source was deleted meanwhile).
 */
export const swapStorageIds = internalMutation({
  args: {
    swaps: v.array(
      v.object({
        fileId: v.id("files"),
        from: v.id("_storage"),
        to: v.id("_storage"),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { swaps }) => {
    for (const { fileId, from, to } of swaps) {
      const file = await ctx.db.get("files", fileId);
      if (file?.storageId === from) {
        await ctx.db.patch("files", fileId, { storageId: to });
        await releaseStorageIfUnreferenced(ctx, from);
      } else {
        await ctx.storage.delete(to);
      }
    }
    return null;
  },
});
