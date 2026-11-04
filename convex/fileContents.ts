import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * Text files keep their content in `fileContents`, not in `files` (#412).
 * Convex bills every byte a query reads, so listing a project now reads only
 * metadata, and an edit no longer re-runs every subscribed file list.
 *
 * Rows written before #412 still hold `files.content` until `backfill` moves
 * it, so every read falls back to it. The fallback, `withoutContent` and
 * `backfill` go once `files.content` is dropped from the schema.
 */

const contentRow = (ctx: QueryCtx, fileId: Id<"files">) =>
  ctx.db
    .query("fileContents")
    .withIndex("by_file", (q) => q.eq("fileId", fileId))
    .unique();

/** A file's text. Falls back to the legacy field until the backfill moves it. */
export const readFileContent = async (ctx: QueryCtx, file: Doc<"files">) =>
  (await contentRow(ctx, file._id))?.content ?? file.content;

/**
 * Sets a file's text, or removes it when `content` is undefined (a binary or
 * deleted file). Clears the legacy field too, so no read falls back to stale
 * text. Pass the stored doc, not one already merged with its content.
 * Leaves `files.updatedAt` alone (nothing reads it), so lists don't re-run.
 */
export const writeFileContent = async (
  ctx: MutationCtx,
  file: Pick<Doc<"files">, "_id" | "projectId" | "content">,
  content: string | undefined,
) => {
  const row = await contentRow(ctx, file._id);
  if (content === undefined) {
    if (row) await ctx.db.delete("fileContents", row._id);
  } else if (row) {
    await ctx.db.patch("fileContents", row._id, { content });
  } else {
    await insertFileContent(ctx, file._id, file.projectId, content);
  }
  if (file.content !== undefined) {
    await ctx.db.patch("files", file._id, { content: undefined });
  }
};

/** The content row of a file this transaction just created (no lookup needed). */
export const insertFileContent = (
  ctx: MutationCtx,
  fileId: Id<"files">,
  projectId: Id<"projects">,
  content: string,
) => ctx.db.insert("fileContents", { fileId, projectId, content });

/** The files with their text, from one read of the project's content rows. */
export const withContents = async <T extends Doc<"files">>(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  files: T[],
) => {
  // Bounded: at most one row per file, and callers already cap `files`.
  const rows = await ctx.db
    .query("fileContents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(files.length);
  const byFile = new Map(rows.map((row) => [row.fileId, row.content]));
  // A full range may be cut short (a project past the caller's cap), so a text
  // file it missed is looked up on its own.
  const truncated = rows.length === files.length;
  return await Promise.all(
    files.map(async (file) => ({
      ...file,
      content:
        byFile.get(file._id) ??
        (truncated && file.type === "file" && !file.storageId
          ? await readFileContent(ctx, file)
          : file.content),
    })),
  );
};

/** Drops the legacy field from list results, so they read the same before and after the backfill. */
export const withoutContent = <T extends { content?: string }>(files: T[]) =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- left out on purpose
  files.map(({ content: _content, ...file }) => file);

/** Files read per backfill batch. */
const BACKFILL_BATCH_SIZE = 100;

/** A file doc is up to 1 MiB, so a batch also stops at this many bytes read. */
const BACKFILL_MAX_BYTES_READ = 4 * 1024 * 1024;

/**
 * Moves legacy `files.content` into `fileContents`, one batch per
 * transaction, rescheduling itself until done. Idempotent: moved files have
 * no legacy field and are skipped, so a broken chain restarts from
 * `{ cursor: null, moved: 0 }` and only redoes what's left.
 */
export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), moved: v.number() },
  returns: v.null(),
  handler: async (ctx, { cursor, moved }) => {
    const page = await ctx.db.query("files").paginate({
      cursor,
      numItems: BACKFILL_BATCH_SIZE,
      maximumBytesRead: BACKFILL_MAX_BYTES_READ,
    });
    for (const file of page.page) {
      if (file.content === undefined) continue;
      await writeFileContent(ctx, file, file.content);
      moved++;
    }
    if (page.isDone) {
      console.log(`[fileContents] backfill done, moved ${moved} files`);
    } else {
      await ctx.scheduler.runAfter(0, internal.fileContents.backfill, {
        cursor: page.continueCursor,
        moved,
      });
    }
    return null;
  },
});
