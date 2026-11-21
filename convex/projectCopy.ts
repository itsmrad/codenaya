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
import { transferableTree } from "./projectTransfer";
import { countProjectBuilt } from "./stats";
import { recordProjectEvent } from "./activationEvents";

/**
 * Copies a project's file tree into another project. Shared by project
 * duplication (`projects.duplicate`) and Remix (`remixProject`).
 */

/** Most projects a user may create per hour through the copy entry points. */
const COPIES_PER_HOUR = 20;

/**
 * Refuses a copy once the user has made `COPIES_PER_HOUR` projects in the last
 * hour. Counts the user's recent projects, so it needs no extra table.
 *
 * shortcut: a soft limiter, upgrade to a real rate limiter if abused.
 * - Deleting a project frees a slot only once its batched delete has run
 *   (`deletingAt` rows still count), and copy-then-delete churn can still
 *   exceed the cap over time.
 * - Other create paths (`projects.create`) are not gated, but their projects
 *   are counted.
 */
export async function assertCanCopy(ctx: MutationCtx, ownerId: string) {
  const recent = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) =>
      q.eq("ownerId", ownerId).gt("_creationTime", Date.now() - 60 * 60 * 1000),
    )
    .take(COPIES_PER_HOUR);
  if (recent.length >= COPIES_PER_HOUR) {
    throw appError(
      "LIMIT_EXCEEDED",
      `You can create up to ${COPIES_PER_HOUR} projects per hour. Try again later.`,
    );
  }
}

/** Largest file tree copied in one transaction. */
export const MAX_COPY_FILES = 5000;

/**
 * Inserts a copy of every file and folder of `sourceId` into `targetId`,
 * keeping the tree shape. Secret files and runtime artifacts are skipped.
 * Binary files share the source's storage blob until
 * `copyBlobs` gives each copy its own. Blob deletes are reference-checked
 * (`releaseStorageIfUnreferenced`), so deleting either side meanwhile, or a
 * `copyBlobs` run that never finishes, can't remove a blob the other uses.
 */
export async function copyProjectFiles(
  ctx: MutationCtx,
  sourceId: Id<"projects">,
  targetId: Id<"projects">,
) {
  const allFiles = await ctx.db
    .query("files")
    .withIndex("by_project", (q) => q.eq("projectId", sourceId))
    .take(MAX_COPY_FILES + 1);

  if (allFiles.length > MAX_COPY_FILES) {
    throw appError(
      "LIMIT_EXCEEDED",
      `Projects with more than ${MAX_COPY_FILES} files can't be copied`,
    );
  }

  const sourceFiles = transferableTree(allFiles);
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
      locked: file.locked,
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

/**
 * A Remix: a new project for `ownerId` holding a copy of `sourceId`'s files
 * only, without secret files. Shared by showcase imports and share links (#260); the caller checks
 * the source may be copied.
 */
export async function remixProject(
  ctx: MutationCtx,
  sourceId: Id<"projects">,
  ownerId: string,
  name: string,
) {
  await assertCanCopy(ctx, ownerId);
  const newProjectId = await ctx.db.insert("projects", {
    name,
    ownerId,
    updatedAt: Date.now(),
  });
  await countProjectBuilt(ctx);
  await recordProjectEvent(ctx, newProjectId, {
    name: "project_created",
    props: { source: "remix" },
  });
  await copyProjectFiles(ctx, sourceId, newProjectId);
  return newProjectId;
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
