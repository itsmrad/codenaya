import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { deleteStorageIfPresent } from "./projectCascade";
import { getOwnedProject } from "./projects";

/**
 * Checkpoints (#43): the project's files as they were just before an agent
 * run, so the run can be undone from the chat.
 *
 * A checkpoint is one `checkpoints` row plus one `checkpointFiles` row per
 * file or folder, keyed by path. Text is copied; binary files keep pointing at
 * their storage blob, which is why a deleted file only frees its blob once no
 * checkpoint references it (`releaseFileStorage`).
 */

/** Checkpoints kept per project; older ones are pruned as new ones are taken. */
export const MAX_CHECKPOINTS_PER_PROJECT = 20;

/** Longest stored label (the prompt that started the run). */
const MAX_LABEL_LENGTH = 140;

/** Each file of a project with its slash-separated path from the root. */
function withPaths(files: Doc<"files">[]) {
  const byId = new Map(files.map((file) => [file._id, file]));
  const paths = new Map<Id<"files">, string>();
  const pathOf = (file: Doc<"files">): string => {
    const cached = paths.get(file._id);
    if (cached !== undefined) return cached;
    const parent = file.parentId ? byId.get(file.parentId) : undefined;
    const path = parent ? `${pathOf(parent)}/${file.name}` : file.name;
    paths.set(file._id, path);
    return path;
  };
  return files.map((file) => ({ file, path: pathOf(file) }));
}

const projectFiles = (ctx: MutationCtx, projectId: Id<"projects">) =>
  ctx.db
    .query("files")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();

const isReferencedByCheckpoint = async (
  ctx: MutationCtx,
  storageId: Id<"_storage">,
) =>
  (await ctx.db
    .query("checkpointFiles")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first()) !== null;

/**
 * Deletes a removed file's blob unless a checkpoint still needs it to restore
 * the file. Pruning the last such checkpoint deletes it then.
 */
export async function releaseFileStorage(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
) {
  if (!(await isReferencedByCheckpoint(ctx, storageId))) {
    await deleteStorageIfPresent(ctx, storageId);
  }
}

/** Deletes a checkpoint and any blob that only it was keeping alive. */
async function deleteCheckpoint(
  ctx: MutationCtx,
  checkpoint: Doc<"checkpoints">,
) {
  const rows = await ctx.db
    .query("checkpointFiles")
    .withIndex("by_checkpoint", (q) => q.eq("checkpointId", checkpoint._id))
    .collect();
  for (const row of rows) {
    await ctx.db.delete("checkpointFiles", row._id);
  }
  await ctx.db.delete("checkpoints", checkpoint._id);

  const blobs = rows.flatMap((row) => (row.storageId ? [row.storageId] : []));
  if (blobs.length === 0) return;
  const live = new Set(
    (await projectFiles(ctx, checkpoint.projectId)).map((file) => file.storageId),
  );
  for (const storageId of blobs) {
    if (!live.has(storageId) && !(await isReferencedByCheckpoint(ctx, storageId))) {
      await deleteStorageIfPresent(ctx, storageId);
    }
  }
}

/**
 * Snapshots the project's files before the run that writes `messageId`.
 * Idempotent per message, so a replayed run step doesn't snapshot its own
 * edits. Keeps the newest MAX_CHECKPOINTS_PER_PROJECT.
 */
export async function createCheckpoint(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    messageId: Id<"messages">;
    label: string;
  },
) {
  const existing = await ctx.db
    .query("checkpoints")
    .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
    .first();
  if (existing) return existing._id;

  const files = withPaths(await projectFiles(ctx, args.projectId));
  const checkpointId = await ctx.db.insert("checkpoints", {
    projectId: args.projectId,
    messageId: args.messageId,
    label: args.label.trim().slice(0, MAX_LABEL_LENGTH),
    fileCount: files.filter(({ file }) => file.type === "file").length,
  });
  for (const { file, path } of files) {
    await ctx.db.insert("checkpointFiles", {
      checkpointId,
      projectId: args.projectId,
      path,
      type: file.type,
      content: file.content,
      storageId: file.storageId,
    });
  }

  const stale = await ctx.db
    .query("checkpoints")
    .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
    .order("desc")
    .collect();
  for (const checkpoint of stale.slice(MAX_CHECKPOINTS_PER_PROJECT)) {
    await deleteCheckpoint(ctx, checkpoint);
  }

  return checkpointId;
}

/**
 * Makes the project's files match the checkpoint in one transaction: files
 * missing from it are deleted, changed ones rewritten, missing ones recreated.
 * Files that already match keep their ids, so open editor tabs stay valid.
 */
async function restoreCheckpoint(
  ctx: MutationCtx,
  checkpoint: Doc<"checkpoints">,
) {
  const rows = await ctx.db
    .query("checkpointFiles")
    .withIndex("by_checkpoint", (q) => q.eq("checkpointId", checkpoint._id))
    .collect();
  const wanted = new Map(rows.map((row) => [row.path, row]));
  const kept = new Map<string, Doc<"files">>();

  for (const { file, path } of withPaths(await projectFiles(ctx, checkpoint.projectId))) {
    if (wanted.get(path)?.type === file.type) {
      kept.set(path, file);
      continue;
    }
    await ctx.db.delete("files", file._id);
    if (file.storageId) await releaseFileStorage(ctx, file.storageId);
  }

  // Parents before children, so every parent id is known when it is needed.
  const depth = (path: string) => path.split("/").length;
  const ids = new Map<string, Id<"files">>();
  const now = Date.now();
  for (const row of [...rows].sort((a, b) => depth(a.path) - depth(b.path))) {
    const existing = kept.get(row.path);
    if (existing) {
      ids.set(row.path, existing._id);
      if (existing.content !== row.content || existing.storageId !== row.storageId) {
        await ctx.db.patch("files", existing._id, {
          content: row.content,
          storageId: row.storageId,
          updatedAt: now,
        });
      }
      continue;
    }
    const slash = row.path.lastIndexOf("/");
    const fileId = await ctx.db.insert("files", {
      projectId: checkpoint.projectId,
      parentId: slash === -1 ? undefined : ids.get(row.path.slice(0, slash)),
      name: row.path.slice(slash + 1),
      type: row.type,
      content: row.content,
      storageId: row.storageId,
      updatedAt: now,
    });
    ids.set(row.path, fileId);
  }

  await ctx.db.patch("projects", checkpoint.projectId, { updatedAt: now });
}

/** The project's checkpoints, newest first. Bounded by the retention cap. */
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    const checkpoints = await ctx.db
      .query("checkpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(MAX_CHECKPOINTS_PER_PROJECT);
    return checkpoints.map(({ _id, _creationTime, messageId, label, fileCount }) => ({
      _id,
      _creationTime,
      messageId,
      label,
      fileCount,
    }));
  },
});

export const restore = mutation({
  args: { checkpointId: v.id("checkpoints") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const checkpoint = await ctx.db.get("checkpoints", args.checkpointId);
    if (!checkpoint) {
      throw new Error("Checkpoint not found");
    }
    await getOwnedProject(ctx, checkpoint.projectId, identity.subject);

    // A running agent would keep writing over the restored files.
    const running = await ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", checkpoint.projectId).eq("status", "processing"),
      )
      .first();
    if (running) {
      throw new Error("Stop the running agent before restoring");
    }

    await restoreCheckpoint(ctx, checkpoint);
  },
});
