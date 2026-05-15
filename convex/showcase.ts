import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import { mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";

// ─── Queries ───

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    category: v.optional(v.string()),
    sortBy: v.optional(
      v.union(v.literal("newest"), v.literal("upvotes"), v.literal("imports"))
    ),
  },
  handler: async (ctx, args) => {
    const sortBy = args.sortBy ?? "newest";

    let q;
    if (args.category) {
      q = ctx.db
        .query("showcaseProjects")
        .withIndex("by_status_and_category", (idx) =>
          idx.eq("status", "published").eq("category", args.category!)
        );
    } else if (sortBy === "upvotes") {
      q = ctx.db
        .query("showcaseProjects")
        .withIndex("by_status_and_upvotes", (idx) =>
          idx.eq("status", "published")
        )
        .order("desc");
    } else {
      q = ctx.db
        .query("showcaseProjects")
        .withIndex("by_status_and_publishedAt", (idx) =>
          idx.eq("status", "published")
        )
        .order("desc");
    }

    const results = await q.paginate(args.paginationOpts);

    const pageWithUrls = await Promise.all(
      results.page.map(async (item) => {
        const previewUrl = item.previewImageId
          ? await ctx.storage.getUrl(item.previewImageId)
          : null;
        return { ...item, previewUrl };
      })
    );

    return { ...results, page: pageWithUrls };
  },
});

export const search = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const results = await ctx.db
      .query("showcaseProjects")
      .withSearchIndex("search_title", (q) =>
        q.search("title", args.query).eq("status", "published")
      )
      .take(limit);

    const withUrls = await Promise.all(
      results.map(async (item) => {
        const previewUrl = item.previewImageId
          ? await ctx.storage.getUrl(item.previewImageId)
          : null;
        return { ...item, previewUrl };
      })
    );

    return withUrls;
  },
});

export const getById = query({
  args: { id: v.id("showcaseProjects") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item || item.status !== "published") {
      return null;
    }

    const previewUrl = item.previewImageId
      ? await ctx.storage.getUrl(item.previewImageId)
      : null;

    return { ...item, previewUrl };
  },
});

export const getUserVote = query({
  args: { showcaseProjectId: v.id("showcaseProjects") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const vote = await ctx.db
      .query("showcaseVotes")
      .withIndex("by_userId_and_showcaseProjectId", (q) =>
        q
          .eq("userId", identity.subject)
          .eq("showcaseProjectId", args.showcaseProjectId)
      )
      .unique();

    return vote?.vote ?? null;
  },
});

export const getMyPublished = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);

    return await ctx.db
      .query("showcaseProjects")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .order("desc")
      .take(50);
  },
});

export const isProjectPublished = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const existing = await ctx.db
      .query("showcaseProjects")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .take(1);

    const published = existing.find((e) => e.status === "published");
    return published ?? null;
  },
});

export const getTrending = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 6;

    const results = await ctx.db
      .query("showcaseProjects")
      .withIndex("by_status_and_upvotes", (q) => q.eq("status", "published"))
      .order("desc")
      .take(limit);

    const withUrls = await Promise.all(
      results.map(async (item) => {
        const previewUrl = item.previewImageId
          ? await ctx.storage.getUrl(item.previewImageId)
          : null;
        return { ...item, previewUrl };
      })
    );

    return withUrls;
  },
});

// ─── Mutations ───

export const publish = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    description: v.string(),
    previewImageId: v.optional(v.id("_storage")),
    techStack: v.array(v.string()),
    designStyle: v.array(v.string()),
    category: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    if (project.ownerId !== identity.subject) {
      throw new Error("Unauthorized");
    }

    const existing = await ctx.db
      .query("showcaseProjects")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .take(1);

    const alreadyPublished = existing.find((e) => e.status === "published");
    if (alreadyPublished) {
      throw new Error("Project is already published to showcase");
    }

    const now = Date.now();

    const showcaseId = await ctx.db.insert("showcaseProjects", {
      projectId: args.projectId,
      ownerId: identity.subject,
      ownerName: identity.name ?? "Anonymous",
      ownerAvatarUrl: identity.pictureUrl,
      title: args.title,
      description: args.description,
      previewImageId: args.previewImageId,
      techStack: args.techStack,
      designStyle: args.designStyle,
      category: args.category,
      upvotes: 0,
      downvotes: 0,
      viewCount: 0,
      importCount: 0,
      status: "published",
      publishedAt: now,
      updatedAt: now,
    });

    return showcaseId;
  },
});

export const unpublish = mutation({
  args: { id: v.id("showcaseProjects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const item = await ctx.db.get(args.id);
    if (!item) throw new Error("Not found");
    if (item.ownerId !== identity.subject) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.id, {
      status: "removed",
      updatedAt: Date.now(),
    });
  },
});

export const vote = mutation({
  args: {
    showcaseProjectId: v.id("showcaseProjects"),
    vote: v.union(v.literal("up"), v.literal("down")),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const item = await ctx.db.get(args.showcaseProjectId);
    if (!item || item.status !== "published") {
      throw new Error("Project not found");
    }

    const existingVote = await ctx.db
      .query("showcaseVotes")
      .withIndex("by_userId_and_showcaseProjectId", (q) =>
        q
          .eq("userId", identity.subject)
          .eq("showcaseProjectId", args.showcaseProjectId)
      )
      .unique();

    if (existingVote) {
      if (existingVote.vote === args.vote) {
        await ctx.db.delete(existingVote._id);
        const field = args.vote === "up" ? "upvotes" : "downvotes";
        await ctx.db.patch(args.showcaseProjectId, {
          [field]: Math.max(0, item[field] - 1),
          updatedAt: Date.now(),
        });
        return "removed";
      } else {
        await ctx.db.patch(existingVote._id, {
          vote: args.vote,
          createdAt: Date.now(),
        });
        const incField = args.vote === "up" ? "upvotes" : "downvotes";
        const decField = args.vote === "up" ? "downvotes" : "upvotes";
        await ctx.db.patch(args.showcaseProjectId, {
          [incField]: item[incField] + 1,
          [decField]: Math.max(0, item[decField] - 1),
          updatedAt: Date.now(),
        });
        return "switched";
      }
    } else {
      await ctx.db.insert("showcaseVotes", {
        showcaseProjectId: args.showcaseProjectId,
        userId: identity.subject,
        vote: args.vote,
        createdAt: Date.now(),
      });
      const field = args.vote === "up" ? "upvotes" : "downvotes";
      await ctx.db.patch(args.showcaseProjectId, {
        [field]: item[field] + 1,
        updatedAt: Date.now(),
      });
      return "added";
    }
  },
});

export const incrementView = mutation({
  args: { id: v.id("showcaseProjects") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;

    const item = await ctx.db.get(args.id);
    if (!item || item.status !== "published") return;

    const existingView = await ctx.db
      .query("showcaseViews")
      .withIndex("by_userId_and_showcaseProjectId", (q) =>
        q.eq("userId", identity.subject).eq("showcaseProjectId", args.id)
      )
      .unique();

    if (existingView) return;

    await ctx.db.insert("showcaseViews", {
      showcaseProjectId: args.id,
      userId: identity.subject,
      viewedAt: Date.now(),
    });

    await ctx.db.patch(args.id, {
      viewCount: item.viewCount + 1,
    });
  },
});

export const importToWorkspace = mutation({
  args: { showcaseProjectId: v.id("showcaseProjects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const showcaseItem = await ctx.db.get(args.showcaseProjectId);
    if (!showcaseItem || showcaseItem.status !== "published") {
      throw new Error("Project not found");
    }

    const now = Date.now();
    const newProjectId = await ctx.db.insert("projects", {
      name: `${showcaseItem.title} (imported)`,
      ownerId: identity.subject,
      updatedAt: now,
    });

    const sourceFiles = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", showcaseItem.projectId))
      .take(5000);

    const idMap = new Map<string, string>();

    for (const file of sourceFiles) {
      const newFileId = await ctx.db.insert("files", {
        projectId: newProjectId,
        parentId: undefined,
        name: file.name,
        type: file.type,
        content: file.content,
        storageId: file.storageId,
        updatedAt: now,
      });
      idMap.set(file._id, newFileId);
    }

    for (const file of sourceFiles) {
      if (file.parentId) {
        const newFileId = idMap.get(file._id);
        const newParentId = idMap.get(file.parentId);
        if (newFileId && newParentId) {
          await ctx.db.patch(newFileId as any, {
            parentId: newParentId as any,
          });
        }
      }
    }

    await ctx.db.patch(args.showcaseProjectId, {
      importCount: showcaseItem.importCount + 1,
      updatedAt: now,
    });

    return newProjectId;
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await verifyAuth(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
