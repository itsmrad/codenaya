import { v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";

import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { copyProjectFiles } from "./projectCopy";
import { countProjectBuilt } from "./stats";

// ─── Queries ───

type ShowcaseSort = "newest" | "upvotes" | "imports";
type ShowcaseTags = { techStack?: string[]; designStyle?: string[] };

/** Published projects, highest `sortBy` value first, optionally in one category. */
const publishedInOrder = (ctx: QueryCtx, sortBy: ShowcaseSort, category?: string) => {
  const table = ctx.db.query("showcaseProjects");
  if (category) {
    const index = {
      newest: "by_status_and_category_and_publishedAt",
      upvotes: "by_status_and_category_and_upvotes",
      imports: "by_status_and_category_and_importCount",
    } as const;
    return table
      .withIndex(index[sortBy], (q) =>
        q.eq("status", "published").eq("category", category)
      )
      .order("desc");
  }
  const index = {
    newest: "by_status_and_publishedAt",
    upvotes: "by_status_and_upvotes",
    imports: "by_status_and_importCount",
  } as const;
  return table
    .withIndex(index[sortBy], (q) => q.eq("status", "published"))
    .order("desc");
};

/**
 * Tag filters have no index (they are arrays), so they apply to each fetched
 * page: a project matches when it has any selected tag of each group. Pages
 * can come back short, and the client loads more to fill in.
 */
const matchesTags = (item: Doc<"showcaseProjects">, tags: ShowcaseTags) =>
  (!tags.techStack?.length || tags.techStack.some((t) => item.techStack.includes(t))) &&
  (!tags.designStyle?.length || tags.designStyle.some((d) => item.designStyle.includes(d)));

/** A page of showcase projects, tag-filtered, each with its preview image URL. */
const toFeedPage = async (
  ctx: QueryCtx,
  results: PaginationResult<Doc<"showcaseProjects">>,
  tags: ShowcaseTags
) => {
  const page = await Promise.all(
    results.page
      .filter((item) => matchesTags(item, tags))
      .map(async (item) => {
        const previewUrl = item.previewImageId
          ? await ctx.storage.getUrl(item.previewImageId)
          : null;
        return { ...item, previewUrl };
      })
  );
  return { ...results, page };
};

const feedFilterArgs = {
  category: v.optional(v.string()),
  techStack: v.optional(v.array(v.string())),
  designStyle: v.optional(v.array(v.string())),
};

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    ...feedFilterArgs,
    sortBy: v.optional(
      v.union(v.literal("newest"), v.literal("upvotes"), v.literal("imports"))
    ),
  },
  handler: async (ctx, args) => {
    const results = await publishedInOrder(
      ctx,
      args.sortBy ?? "newest",
      args.category
    ).paginate(args.paginationOpts);
    return await toFeedPage(ctx, results, args);
  },
});

/** Title search, best match first. */
export const search = query({
  args: {
    paginationOpts: paginationOptsValidator,
    query: v.string(),
    ...feedFilterArgs,
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("showcaseProjects")
      .withSearchIndex("search_title", (q) => {
        const published = q.search("title", args.query).eq("status", "published");
        return args.category ? published.eq("category", args.category) : published;
      })
      .paginate(args.paginationOpts);
    return await toFeedPage(ctx, results, args);
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
    await verifyAuth(ctx);

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
    await countProjectBuilt(ctx);

    await copyProjectFiles(ctx, showcaseItem.projectId, newProjectId);

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
