import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { v } from "convex/values";

import { runWrittenPaths } from "../src/features/conversations/agent-steps";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import {
  insertFileContent,
  readFileContent,
  withContents,
  writeFileContent,
} from "./fileContents";
import { deleteFileTree, findSibling, getOwnedFile, MAX_PROJECT_FILES } from "./files";
import { releaseBlobs, releaseStorageIfUnreferenced } from "./projectCascade";
import { getOwnedProject } from "./projects";

/**
 * Checkpoints (#43): the project's files as they were just before an agent
 * run, so the run can be undone from the chat.
 *
 * A checkpoint is one `checkpoints` row plus one `checkpointFiles` row per
 * file or folder, keyed by path. Text is copied; binary files keep pointing at
 * their storage blob, which is why a deleted file only frees its blob once no
 * checkpoint references it (`releaseStorageIfUnreferenced`).
 */

/** Checkpoints kept per project; older ones are pruned as new ones are taken. */
export const MAX_CHECKPOINTS_PER_PROJECT = 20;

/** Longest stored label (the prompt that started the run). */
const MAX_LABEL_LENGTH = 140;

/**
 * Largest project snapshotted, so a snapshot plus the prune of an old one fit
 * in one transaction (#212). No snapshot holds more rows than this.
 */
const MAX_CHECKPOINT_FILES = 2000;

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

/** All of a project's files; refuses a project too big to snapshot whole. */
async function projectFiles(ctx: MutationCtx, projectId: Id<"projects">) {
  const files = await ctx.db
    .query("files")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(MAX_CHECKPOINT_FILES + 1);
  if (files.length > MAX_CHECKPOINT_FILES) {
    throw appError(
      "LIMIT_EXCEEDED",
      `Projects with more than ${MAX_CHECKPOINT_FILES} files have no checkpoints`,
    );
  }
  return files;
}

const checkpointRows = (ctx: QueryCtx, checkpointId: Id<"checkpoints">) =>
  ctx.db
    .query("checkpointFiles")
    .withIndex("by_checkpoint_and_path", (q) => q.eq("checkpointId", checkpointId));

/** Deletes a checkpoint and any blob that only it was keeping alive. */
async function deleteCheckpoint(
  ctx: MutationCtx,
  checkpoint: Doc<"checkpoints">,
) {
  // ponytail: a pre-#212 snapshot over the cap leaves its extra rows (and
  // their blobs) to the project cascade; throwing here would fail every later
  // snapshot of the project.
  const rows = await checkpointRows(ctx, checkpoint._id).take(MAX_CHECKPOINT_FILES);
  for (const row of rows) {
    await ctx.db.delete("checkpointFiles", row._id);
  }
  await ctx.db.delete("checkpoints", checkpoint._id);

  await releaseBlobs(ctx, rows.map((row) => row.storageId));
}

/**
 * Snapshots the project's files before the run that writes `messageId`, or,
 * without one, before a restore or manual delete (#259). Idempotent per
 * message, so a replayed run step doesn't snapshot its own edits. Keeps the
 * newest MAX_CHECKPOINTS_PER_PROJECT, never pruning `keep`.
 */
export async function createCheckpoint(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    messageId?: Id<"messages">;
    label: string;
    /** A checkpoint the caller still needs, e.g. the one being restored. */
    keep?: Id<"checkpoints">;
  },
) {
  const { messageId } = args;
  if (messageId) {
    const existing = await ctx.db
      .query("checkpoints")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first();
    if (existing) return existing._id;
  }

  const files = withPaths(
    await withContents(ctx, args.projectId, await projectFiles(ctx, args.projectId)),
  );
  const checkpointId = await ctx.db.insert("checkpoints", {
    projectId: args.projectId,
    ...(messageId ? { messageId } : {}),
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
    // Every snapshot prunes, so at most one is over the cap, two when the
    // previous snapshot kept a checkpoint past it.
    .take(MAX_CHECKPOINTS_PER_PROJECT + 2);
  for (const checkpoint of stale.slice(MAX_CHECKPOINTS_PER_PROJECT)) {
    if (checkpoint._id !== args.keep) await deleteCheckpoint(ctx, checkpoint);
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
  // A pre-#212 snapshot can be over the cap. Restoring part of it would delete
  // every file outside that part, so refuse it whole.
  const rows = await checkpointRows(ctx, checkpoint._id).take(MAX_CHECKPOINT_FILES + 1);
  if (rows.length > MAX_CHECKPOINT_FILES) {
    throw appError("LIMIT_EXCEEDED", "This checkpoint is too large to restore");
  }
  const wanted = new Map(rows.map((row) => [row.path, row]));
  const kept = new Map<string, Doc<"files">>();

  const files = await projectFiles(ctx, checkpoint.projectId);
  const text = new Map(
    (await withContents(ctx, checkpoint.projectId, files)).map((file) => [file._id, file.content]),
  );
  for (const { file, path } of withPaths(files)) {
    if (wanted.get(path)?.type === file.type) {
      kept.set(path, file);
      continue;
    }
    await writeFileContent(ctx, file, undefined);
    await ctx.db.delete("files", file._id);
    if (file.storageId) await releaseStorageIfUnreferenced(ctx, file.storageId);
  }

  // Parents before children, so every parent id is known when it is needed.
  const depth = (path: string) => path.split("/").length;
  const ids = new Map<string, Id<"files">>();
  const now = Date.now();
  for (const row of [...rows].sort((a, b) => depth(a.path) - depth(b.path))) {
    const existing = kept.get(row.path);
    if (existing) {
      ids.set(row.path, existing._id);
      if (text.get(existing._id) !== row.content) {
        await writeFileContent(ctx, existing, row.content);
      }
      if (existing.storageId !== row.storageId) {
        await ctx.db.patch("files", existing._id, { storageId: row.storageId, updatedAt: now });
      }
      continue;
    }
    const slash = row.path.lastIndexOf("/");
    const fileId = await ctx.db.insert("files", {
      projectId: checkpoint.projectId,
      parentId: slash === -1 ? undefined : ids.get(row.path.slice(0, slash)),
      name: row.path.slice(slash + 1),
      type: row.type,
      storageId: row.storageId,
      updatedAt: now,
    });
    if (row.content !== undefined) {
      await insertFileContent(ctx, fileId, checkpoint.projectId, row.content);
    }
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

/** The caller's checkpoint. */
async function getOwnedCheckpoint(ctx: QueryCtx, checkpointId: Id<"checkpoints">) {
  const identity = await verifyAuth(ctx);
  const checkpoint = await ctx.db.get("checkpoints", checkpointId);
  if (!checkpoint) {
    throw new Error("Checkpoint not found");
  }
  await getOwnedProject(ctx, checkpoint.projectId, identity.subject);
  return checkpoint;
}

/** A running agent would keep writing over the restored files. */
async function assertNoRunningAgent(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  action: string,
) {
  const running = await ctx.db
    .query("messages")
    .withIndex("by_project_status", (q) =>
      q.eq("projectId", projectId).eq("status", "processing"),
    )
    .first();
  if (running) {
    throw new Error(`Stop the running agent before ${action}`);
  }
}

/**
 * Restores a checkpoint. Snapshots the current files first, in the same
 * transaction, and returns that snapshot's id so the restore can be undone
 * by restoring it (#259).
 */
export const restore = mutation({
  args: { checkpointId: v.id("checkpoints") },
  handler: async (ctx, args) => {
    const checkpoint = await getOwnedCheckpoint(ctx, args.checkpointId);
    await assertNoRunningAgent(ctx, checkpoint.projectId, "restoring");
    const undoCheckpointId = await createCheckpoint(ctx, {
      projectId: checkpoint.projectId,
      label: "Before restore",
      keep: checkpoint._id,
    });
    await restoreCheckpoint(ctx, checkpoint);
    return undoCheckpointId;
  },
});

/**
 * Deletes a file or folder from the explorer. Snapshots the project first,
 * in the same transaction, and returns the snapshot's id so the delete can
 * be undone by restoring it (#259).
 */
export const deleteFileWithUndo = mutation({
  args: { id: v.id("files") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const { file } = await getOwnedFile(ctx, args.id, identity.subject);
    const undoCheckpointId = await createCheckpoint(ctx, {
      projectId: file.projectId,
      label: `Before deleting ${file.name}`,
    });
    await deleteFileTree(ctx, file);
    await ctx.db.patch("projects", file.projectId, { updatedAt: Date.now() });
    return undoCheckpointId;
  },
});

/** Largest side of a file the chat diffs, in characters (#225). */
export const MAX_DIFF_CHARS = 200_000;

/**
 * Most rows (or live files) one side of a run's diff reads. Each row carries
 * its text, so a run that moved a big folder gets no diff rather than a query
 * over Convex's read limits.
 */
export const MAX_DIFF_FILES = 200;

/** What `unifiedMergeView` uses by default, so the counts match the dialog. */
const DIFF_CONFIG = { scanLimit: 500 };

/** One side of a changed file: its text, or its blob when binary. */
interface FileState {
  content?: string;
  storageId?: Id<"_storage">;
}

const countLines = (text: string) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** Lines added and removed going from `before` to `after`. */
export function lineDelta(before: string, after: string) {
  if (before === "" || after === "") {
    return { additions: countLines(after), deletions: countLines(before) };
  }
  const a = Text.of(before.split("\n"));
  const b = Text.of(after.split("\n"));
  // A chunk ends one past its last line, or at its start when it has none.
  const lines = (doc: Text, from: number, to: number) =>
    to > from ? doc.lineAt(to - 1).number - doc.lineAt(from).number + 1 : 0;
  let additions = 0;
  let deletions = 0;
  for (const chunk of Chunk.build(a, b, DIFF_CONFIG)) {
    deletions += lines(a, chunk.fromA, chunk.toA);
    additions += lines(b, chunk.fromB, chunk.toB);
  }
  return { additions, deletions };
}

/** Whether `path` is one of the targets or inside one (a folder stands for its contents). */
const isUnder = (path: string, targets: string[]) =>
  targets.some((target) => path === target || path.startsWith(`${target}/`));

/** The checkpoint's files at or under each target path; null past MAX_DIFF_FILES rows. */
async function checkpointState(
  ctx: QueryCtx,
  checkpointId: Id<"checkpoints">,
  targets: string[],
) {
  const state = new Map<string, FileState>();
  let read = 0;
  for (const target of targets) {
    // A file and a folder may share a path, hence 2.
    const rows = await ctx.db
      .query("checkpointFiles")
      .withIndex("by_checkpoint_and_path", (q) =>
        q.eq("checkpointId", checkpointId).eq("path", target),
      )
      .take(2);
    read += rows.length;
    if (read > MAX_DIFF_FILES) return null;
    // "0" sorts right after "/", so this is everything under the folder.
    const nested = await ctx.db
      .query("checkpointFiles")
      .withIndex("by_checkpoint_and_path", (q) =>
        q.eq("checkpointId", checkpointId).gte("path", `${target}/`).lt("path", `${target}0`),
      )
      .take(MAX_DIFF_FILES + 1 - read);
    read += nested.length;
    if (read > MAX_DIFF_FILES) return null;
    for (const row of [...rows, ...nested]) {
      if (row.type === "file") {
        state.set(row.path, { content: row.content, storageId: row.storageId });
      }
    }
  }
  return state;
}

/** The project's current files at or under each target path; null past MAX_DIFF_FILES. */
async function liveState(ctx: QueryCtx, projectId: Id<"projects">, targets: string[]) {
  const files = await ctx.db
    .query("files")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(MAX_PROJECT_FILES);
  const matches = withPaths(files).filter(
    ({ file, path }) => file.type === "file" && isUnder(path, targets),
  );
  if (matches.length > MAX_DIFF_FILES) return null;
  const state = new Map<string, FileState>();
  for (const { file, path } of matches) {
    state.set(path, {
      content: file.storageId ? undefined : await readFileContent(ctx, file),
      storageId: file.storageId,
    });
  }
  return state;
}

/** The paths the checkpoint's run wrote (a folder stands for its contents). */
const runTargets = async (ctx: QueryCtx, checkpoint: Doc<"checkpoints">) =>
  checkpoint.messageId
    ? runWrittenPaths((await ctx.db.get("messages", checkpoint.messageId))?.steps ?? [])
    : [];

/**
 * The files the checkpoint's run changed, before and after it (#225), or just
 * `only` when given. Only the paths the run wrote count, so manual edits to
 * other files don't show. After is the snapshot taken before the project's
 * next run, or the live files when this is the latest run. Null when there
 * are too many files to diff.
 */
async function runChanges(ctx: QueryCtx, checkpoint: Doc<"checkpoints">, only?: string) {
  const written = await runTargets(ctx, checkpoint);
  const targets =
    only === undefined
      ? // A file inside a folder the run also wrote is read with the folder.
        written.filter((target) => !written.some((other) => target.startsWith(`${other}/`)))
      : isUnder(only, written)
        ? [only]
        : [];
  if (targets.length === 0) return [];

  const next = await ctx.db
    .query("checkpoints")
    .withIndex("by_project", (q) =>
      q.eq("projectId", checkpoint.projectId).gt("_creationTime", checkpoint._creationTime),
    )
    .first();
  const before = await checkpointState(ctx, checkpoint._id, targets);
  if (!before) return null;
  const after = next
    ? await checkpointState(ctx, next._id, targets)
    : await liveState(ctx, checkpoint.projectId, targets);
  if (!after) return null;

  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((path) => ({ path, before: before.get(path), after: after.get(path) }))
    .filter(
      ({ before, after }) =>
        before?.content !== after?.content || before?.storageId !== after?.storageId,
    );
}

/** A change as listed in the chat: status and line counts, no contents. */
function summarize({ path, before, after }: NonNullable<Awaited<ReturnType<typeof runChanges>>>[number]) {
  const binary = Boolean(before?.storageId || after?.storageId);
  const a = before?.content ?? "";
  const b = after?.content ?? "";
  const tooLarge = !binary && Math.max(a.length, b.length) > MAX_DIFF_CHARS;
  return {
    path,
    status: !before ? ("added" as const) : !after ? ("deleted" as const) : ("modified" as const),
    binary,
    tooLarge,
    ...(binary || tooLarge ? {} : lineDelta(a, b)),
  };
}

/**
 * The files a run changed, with line counts; no contents (#225). Null when
 * the run touched more than MAX_DIFF_FILES files.
 */
export const listChanges = query({
  args: { checkpointId: v.id("checkpoints") },
  handler: async (ctx, args) => {
    const checkpoint = await getOwnedCheckpoint(ctx, args.checkpointId);
    return (await runChanges(ctx, checkpoint))?.map(summarize) ?? null;
  },
});

/**
 * One changed file's text before and after the run, or null when the run
 * didn't change it. Binary and too-large files come without contents.
 */
export const fileDiff = query({
  args: { checkpointId: v.id("checkpoints"), path: v.string() },
  handler: async (ctx, args) => {
    const checkpoint = await getOwnedCheckpoint(ctx, args.checkpointId);
    const changes = await runChanges(ctx, checkpoint, args.path);
    const change = changes?.find(({ path }) => path === args.path);
    if (!change) return null;
    const summary = summarize(change);
    if (summary.binary || summary.tooLarge) return summary;
    return { ...summary, before: change.before?.content ?? "", after: change.after?.content ?? "" };
  },
});

/** The folder at `segments` (undefined: the root); missing ones are created, or give null. */
async function folderAt(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  segments: string[],
  create: boolean,
) {
  let parentId: Id<"files"> | undefined;
  for (const name of segments) {
    const folder = await findSibling(ctx, { projectId, parentId, name, type: "folder" });
    if (folder) {
      parentId = folder._id;
    } else if (create) {
      parentId = await ctx.db.insert("files", {
        projectId,
        parentId,
        name,
        type: "folder",
        updatedAt: Date.now(),
      });
    } else {
      return null;
    }
  }
  return parentId;
}

/**
 * Puts one file back as it was before the checkpoint's run (#225): rewritten,
 * recreated with its folders, or deleted when the run created it. Other files
 * are left alone.
 * shortcut: whole file only; hunk revert (#225 follow-up) would add an optional range.
 */
export const revertFile = mutation({
  args: { checkpointId: v.id("checkpoints"), path: v.string() },
  handler: async (ctx, args) => {
    const checkpoint = await getOwnedCheckpoint(ctx, args.checkpointId);
    const { projectId } = checkpoint;
    await assertNoRunningAgent(ctx, projectId, "reverting");
    // Any other path would delete or overwrite a file the run never touched.
    if (!isUnder(args.path, await runTargets(ctx, checkpoint))) {
      throw appError("NOT_FOUND", "This run didn't change that file");
    }

    const row = (
      await ctx.db
        .query("checkpointFiles")
        .withIndex("by_checkpoint_and_path", (q) =>
          q.eq("checkpointId", checkpoint._id).eq("path", args.path),
        )
        .take(2)
    ).find((candidate) => candidate.type === "file");
    const segments = args.path.split("/");
    const name = segments.pop()!;
    // Folders are only recreated when there is a file to put back.
    const parentId = await folderAt(ctx, projectId, segments, Boolean(row));
    const live =
      parentId === null
        ? null
        : await findSibling(ctx, { projectId, parentId, name, type: "file" });

    const now = Date.now();
    if (!row) {
      if (!live) return;
      await deleteFileTree(ctx, live);
    } else if (live) {
      if (live.storageId !== row.storageId) {
        await ctx.db.patch("files", live._id, { storageId: row.storageId, updatedAt: now });
        if (live.storageId) await releaseStorageIfUnreferenced(ctx, live.storageId);
      }
      if ((await readFileContent(ctx, live)) !== row.content) {
        await writeFileContent(ctx, live, row.content);
      }
    } else {
      const fileId = await ctx.db.insert("files", {
        projectId,
        parentId: parentId ?? undefined,
        name,
        type: "file",
        storageId: row.storageId,
        updatedAt: now,
      });
      if (row.content !== undefined) {
        await insertFileContent(ctx, fileId, projectId, row.content);
      }
    }
    await ctx.db.patch("projects", projectId, { updatedAt: now });
  },
});
