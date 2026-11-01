import { v } from "convex/values";

import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import {
  insertFileContent,
  readFileContent,
  withContents,
  withoutContent,
  writeFileContent,
} from "./fileContents";
import {
  CASCADE_BATCH_SIZE,
  releaseStorageIfUnreferenced,
} from "./projectCascade";
import { getOwnedProject } from "./projects";
import { recordPackageJsonReady } from "./activationEvents";
import { Doc, Id } from "./_generated/dataModel";

/** Most files read from one project or folder at once (#53). */
export const MAX_PROJECT_FILES = 5000;

// File and parent ids come from the client or from model output, so every file
// and parent folder a write touches must belong to that write's project (#209, #239).
export const getProjectFile = async (
  ctx: QueryCtx,
  projectId: Id<"projects">,
  fileId: Id<"files">
) => {
  const file = await ctx.db.get("files", fileId);
  return file && file.projectId === projectId ? file : null;
};

export const assertProjectFolder = async (
  ctx: QueryCtx,
  projectId: Id<"projects">,
  parentId: Id<"files"> | undefined
) => {
  if (!parentId) return;
  const parent = await getProjectFile(ctx, projectId, parentId);
  if (!parent || parent.type !== "folder") {
    throw new Error("Parent folder not found");
  }
};

/** The caller's file and its project, which must not be mid-deletion (#212). */
const getOwnedFile = async (
  ctx: QueryCtx,
  id: Id<"files">,
  ownerId: string
) => {
  const file = await ctx.db.get("files", id);
  if (!file) throw appError("NOT_FOUND", "File not found");
  const project = await getOwnedProject(ctx, file.projectId, ownerId);
  return { file, project };
};

/** Another file or folder with this name and type in the same folder, if any. */
export const findSibling = async (
  ctx: QueryCtx,
  file: Pick<Doc<"files">, "projectId" | "parentId" | "name" | "type">,
  exceptId?: Id<"files">
) => {
  const sameName = ctx.db
    .query("files")
    .withIndex("by_project_and_parent_and_name", (q) =>
      q
        .eq("projectId", file.projectId)
        .eq("parentId", file.parentId)
        .eq("name", file.name)
    );
  // Bounded: these writes keep one file and one folder per name in a folder.
  for await (const sibling of sameName) {
    if (sibling.type === file.type && sibling._id !== exceptId) return sibling;
  }
  return null;
};

/**
 * Deletes a file, or a folder and everything under it. A folder's contents go
 * in scheduled batches (`deleteFolderContents`), so a folder of any size stays
 * inside one transaction's limits (#212).
 */
export const deleteFileTree = async (ctx: MutationCtx, file: Doc<"files">) => {
  // Any file can hold a row (updateFile doesn't check the type), so always look.
  await writeFileContent(ctx, file, undefined);
  await ctx.db.delete("files", file._id);

  // Then its blob, unless another file or checkpoint still uses it
  if (file.storageId) {
    await releaseStorageIfUnreferenced(ctx, file.storageId);
  }

  if (file.type === "folder") {
    await ctx.scheduler.runAfter(0, internal.files.deleteFolderContents, {
      projectId: file.projectId,
      parentId: file._id,
    });
  }
};

/** One batch of a deleted folder's children; reschedules itself until done. */
export const deleteFolderContents = internalMutation({
  args: { projectId: v.id("projects"), parentId: v.id("files") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const children = await ctx.db
      .query("files")
      .withIndex("by_project_and_parent_and_name", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId)
      )
      .take(CASCADE_BATCH_SIZE);

    for (const child of children) {
      await deleteFileTree(ctx, child);
    }

    if (children.length === CASCADE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.files.deleteFolderContents, args);
    }
    return null;
  },
});

export const getFiles = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_PROJECT_FILES);
    return withoutContent(files);
  },
});

/**
 * All files of a project with their text, and a download URL for binary
 * (storage) files. Used for: Download ZIP, preview
 */
export const getFilesWithUrls = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_PROJECT_FILES);

    return await Promise.all(
      (await withContents(ctx, args.projectId, files)).map(async (file) => ({
        ...file,
        storageUrl: file.storageId
          ? await ctx.storage.getUrl(file.storageId)
          : null,
      }))
    );
  },
});

export const getFile = query({
  args: { id: v.id("files") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const { file } = await getOwnedFile(ctx, args.id, identity.subject);

    return { ...file, content: await readFileContent(ctx, file) };
  },
});

/**
 * Builds the full path to a file by traversing up the parent chain.
 *
 * Input:  A file ID (e.g., the ID of "button.tsx")
 * Output: Array of ancestors from root to file: [{ _id, name: "src" }, { _id, name: "components" }, { _id, name: "button.tsx" }]
 *
 * Used for: Breadcrumbs navigation (src > components > button.tsx)
 */
export const getFilePath = query({
  args: { id: v.id("files") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const { project } = await getOwnedFile(ctx, args.id, identity.subject);

    const path: { _id: string; name: string }[] = [];
    let currentId: Id<"files"> | undefined = args.id;

    while (currentId) {
      const file = (await ctx.db.get("files", currentId)) as
        | Doc<"files">
        | undefined;
      // A parent from another project is never part of this file's path (#239).
      if (!file || file.projectId !== project._id) break;

      path.unshift({ _id: file._id, name: file.name });
      currentId = file.parentId;
    }

    return path;
  },
});

export const getFolderContents = query({
  args: {
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_and_parent_and_name", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("parentId", args.parentId)
      )
      .take(MAX_PROJECT_FILES);

    // Sort: folders first, then files, alphabetically within each group
    return withoutContent(files).sort((a, b) => {
      // Folders come before files
      if (a.type === "folder" && b.type === "file") return -1;
      if (a.type === "file" && b.type === "folder") return 1;

      // Within same type, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  },
});

export const createFile = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
    name: v.string(),
    content: v.string(),
  },
  // The explorer opens the new file by this id once it's confirmed (#266).
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    await assertProjectFolder(ctx, args.projectId, args.parentId);

    if (await findSibling(ctx, { ...args, type: "file" })) {
      throw appError("CONFLICT", "File already exists");
    }

    const now = Date.now();

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      type: "file",
      parentId: args.parentId,
      updatedAt: now,
    });
    await insertFileContent(ctx, fileId, args.projectId, args.content);
    await recordPackageJsonReady(ctx, args);

    await ctx.db.patch("projects", args.projectId, {
      updatedAt: now,
    });

    return fileId;
  },
});

export const createFolder = mutation({
  args: {
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    await assertProjectFolder(ctx, args.projectId, args.parentId);

    if (await findSibling(ctx, { ...args, type: "folder" })) {
      throw appError("CONFLICT", "Folder already exists");
    }

    const now = Date.now();

    await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      type: "folder",
      parentId: args.parentId,
      updatedAt: now,
    });

    await ctx.db.patch("projects", args.projectId, {
      updatedAt: now,
    });
  },
});

export const renameFile = mutation({
  args: {
    id: v.id("files"),
    newName: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const { file } = await getOwnedFile(ctx, args.id, identity.subject);

    // Check if a file with the new name already exists in the same parent folder
    if (await findSibling(ctx, { ...file, name: args.newName }, args.id)) {
      throw appError(
        "CONFLICT",
        `A ${file.type} with this name already exists in this location`
      );
    }

    const now = Date.now();

    // Update the file's name
    await ctx.db.patch("files", args.id, {
      name: args.newName,
      updatedAt: now,
    });

    await ctx.db.patch("projects", file.projectId, {
      updatedAt: now,
    });
  }
});

export const deleteFile = mutation({
  args: {
    id: v.id("files"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const { file } = await getOwnedFile(ctx, args.id, identity.subject);

    await deleteFileTree(ctx, file);

    await ctx.db.patch("projects", file.projectId, {
      updatedAt: Date.now(),
    });
  }
});

export const updateFile = mutation({
  args: {
    id: v.id("files"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const { file } = await getOwnedFile(ctx, args.id, identity.subject);

    // Doesn't touch the `files` doc, so file lists don't re-run on every autosave.
    await writeFileContent(ctx, file, args.content);

    await ctx.db.patch("projects", file.projectId, {
      updatedAt: Date.now(),
    });
  },
});
