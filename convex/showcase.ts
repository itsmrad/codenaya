import { v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
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

/**
 * A published entry as anyone may see it, with its preview image URL. The
 * project and owner ids stay private: API routes act on a project id, so a
 * public one would hand every visitor a target (#208).
 */
const toPublicEntry = async (
  ctx: QueryCtx,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- left out on purpose
  { projectId, ownerId, ...entry }: Doc<"showcaseProjects">
) => {
  const previewUrl = entry.previewImageId
    ? await ctx.storage.getUrl(entry.previewImageId)
    : null;
  return { ...entry, previewUrl };
};

/** A page of public showcase entries, tag-filtered. */
const toFeedPage = async (
  ctx: QueryCtx,
  results: PaginationResult<Doc<"showcaseProjects">>,
  tags: ShowcaseTags
) => {
  const page = await Promise.all(
    results.page
      .filter((item) => matchesTags(item, tags))
      .map((item) => toPublicEntry(ctx, item))
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

    return await toPublicEntry(ctx, item);
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

    // An unlisted entry is still published as far as its owner is concerned.
    const published = existing.find((e) => e.status !== "removed");
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

    return await Promise.all(results.map((item) => toPublicEntry(ctx, item)));
  },
});

/** Most entries `getFeatured` returns. */
const FEATURED_MAX = 24;
/** How many top-voted entries the fallback looks through for covers (>= FEATURED_MAX). */
const FALLBACK_WINDOW = 50;

/**
 * Entries for the landing page strip: the hand-picked ones, most recently
 * published first. Until something is featured, the most upvoted entries
 * with a screenshot stand in, so the strip never shows placeholder art.
 */
export const getFeatured = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 6), 1), FEATURED_MAX);

    let results = await ctx.db
      .query("showcaseProjects")
      .withIndex("by_status_and_featured_and_publishedAt", (q) =>
        q.eq("status", "published").eq("featured", true)
      )
      .order("desc")
      .take(limit);

    if (results.length === 0) {
      const topVoted = await ctx.db
        .query("showcaseProjects")
        .withIndex("by_status_and_upvotes", (q) => q.eq("status", "published"))
        .order("desc")
        .take(FALLBACK_WINDOW);
      results = topVoted.filter((item) => item.previewImageId).slice(0, limit);
    }

    return await Promise.all(results.map((item) => toPublicEntry(ctx, item)));
  },
});

// ─── Mutations ───

/**
 * Clerk user ids whose entries stay off the public pages: the e2e user pool
 * and other test accounts, as a comma-separated list in the deployment's
 * SHOWCASE_UNLISTED_OWNER_IDS. Exact ids, never email patterns, so a real
 * user can't be caught by accident. Dev leaves it unset: the feed specs need
 * their seeds listed.
 */
const unlistedOwnerIds = () =>
  (process.env.SHOWCASE_UNLISTED_OWNER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

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

    const alreadyPublished = existing.find((e) => e.status !== "removed");
    if (alreadyPublished) {
      throw new Error("Project is already published to showcase");
    }

    const now = Date.now();

    const rawEmail = identity.email;
    const emailLocalPart = rawEmail ? rawEmail.split("@")[0] : null;
    const authorName =
      identity.name ||
      identity.nickname ||
      ((identity as Record<string, unknown>).username as string | undefined) ||
      emailLocalPart ||
      "Anonymous";

    const showcaseId = await ctx.db.insert("showcaseProjects", {
      projectId: args.projectId,
      ownerId: identity.subject,
      ownerName: authorName,
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
      status: unlistedOwnerIds().includes(identity.subject) ? "unlisted" : "published",
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
  args: {
    id: v.id("showcaseProjects"),
    anonymousId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const item = await ctx.db.get(args.id);
    if (!item || item.status !== "published") return;

    // Do not count the publisher's own visits
    if (identity && identity.subject === item.ownerId) {
      return;
    }

    const viewerId = identity ? identity.subject : args.anonymousId;
    if (!viewerId) return;

    const existingView = await ctx.db
      .query("showcaseViews")
      .withIndex("by_userId_and_showcaseProjectId", (q) =>
        q.eq("userId", viewerId).eq("showcaseProjectId", args.id)
      )
      .unique();

    if (existingView) return;

    await ctx.db.insert("showcaseViews", {
      showcaseProjectId: args.id,
      userId: viewerId,
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

// ─── Curation (internal: run from the Convex dashboard or `npx convex run`) ───

/**
 * Features an entry (see `getFeatured`), or unfeatures it. Only published
 * entries with a screenshot qualify: featured entries are meant for the
 * landing page, so they show real work, not placeholder art.
 */
export const setFeatured = internalMutation({
  args: { id: v.id("showcaseProjects"), featured: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item) throw new Error("Not found");
    if (args.featured) {
      if (item.status !== "published") throw new Error("Only published entries can be featured");
      if (!item.previewImageId) throw new Error("Add a screenshot before featuring this entry");
    }
    await ctx.db.patch(args.id, { featured: args.featured, updatedAt: Date.now() });
    return null;
  },
});

const UNLIST_BATCH = 200;

/**
 * One-off cleanup: unlists the published entries of `ownerIds` (default:
 * SHOWCASE_UNLISTED_OWNER_IDS). A dry run unless `apply` is true: it logs
 * each entry it would unlist either way, so the ids are on record for
 * `relistEntries`. Walks the published entries in batches, scheduling itself
 * until done.
 */
export const unlistTestEntries = internalMutation({
  args: {
    ownerIds: v.optional(v.array(v.string())),
    apply: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    matched: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerIds = args.ownerIds ?? unlistedOwnerIds();
    if (ownerIds.length === 0) {
      throw new Error("Pass ownerIds or set SHOWCASE_UNLISTED_OWNER_IDS");
    }
    const apply = args.apply ?? false;
    const verb = apply ? "Unlisted" : "Would unlist";

    const page = await ctx.db
      .query("showcaseProjects")
      .withIndex("by_status_and_publishedAt", (q) => q.eq("status", "published"))
      .paginate({ cursor: args.cursor ?? null, numItems: UNLIST_BATCH });

    const matches = page.page.filter((item) => ownerIds.includes(item.ownerId));
    const now = Date.now();
    for (const item of matches) {
      console.log(`${verb} ${item._id} "${item.title}" (owner ${item.ownerId})`);
      if (apply) {
        await ctx.db.patch(item._id, { status: "unlisted", featured: false, updatedAt: now });
      }
    }
    const matched = (args.matched ?? 0) + matches.length;

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.showcase.unlistTestEntries, {
        ownerIds,
        apply,
        cursor: page.continueCursor,
        matched,
      });
      return null;
    }
    console.log(`${verb} ${matched} showcase entries`);
    return null;
  },
});

/** Undoes `unlistTestEntries` for the given entries: unlisted ones go back to published. */
export const relistEntries = internalMutation({
  args: { ids: v.array(v.id("showcaseProjects")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const item = await ctx.db.get(id);
      if (item?.status === "unlisted") {
        await ctx.db.patch(id, { status: "published", updatedAt: Date.now() });
      }
    }
    return null;
  },
});
