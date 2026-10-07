import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { verifyAuth } from "./auth";
import {
  CASCADE_BATCH_SIZE,
  deleteProjectBatch,
  deleteRows,
  deleteShowcaseBatch,
} from "./projectCascade";

/**
 * Users mirrored from Clerk.
 *
 * Clerk is the source of truth; the webhook in `convex/http.ts` feeds
 * `upsertFromClerk` and `markDeleted`. `ensureCurrent` covers the gap when a
 * user signs in before their `user.created` event has been delivered.
 */

const profileFields = {
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
};

const getByClerkUserId = (ctx: QueryCtx, clerkUserId: string) =>
  ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
    .unique();

/** The signed-in user's profile, or null before the first sync. */
export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await getByClerkUserId(ctx, identity.subject);
    return user && !user.deletedAt ? user : null;
  },
});

/** Creates the signed-in user's row from JWT claims if the webhook has not yet. */
export const ensureCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);

    const existing = await getByClerkUserId(ctx, identity.subject);
    if (existing) return existing._id;

    return await ctx.db.insert("users", {
      clerkUserId: identity.subject,
      email: identity.email,
      name: identity.name,
      imageUrl: identity.pictureUrl,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Applies a `user.created` / `user.updated` event. Idempotent: replaying an
 * event rewrites the same row. Events older than the stored profile (Svix does
 * not guarantee order) and events for deleted users are ignored.
 */
export const upsertFromClerk = internalMutation({
  args: {
    clerkUserId: v.string(),
    ...profileFields,
    // Clerk's `updated_at` for this version of the user.
    updatedAt: v.number(),
  },
  handler: async (ctx, { clerkUserId, ...profile }) => {
    const existing = await getByClerkUserId(ctx, clerkUserId);

    if (!existing) {
      await ctx.db.insert("users", { clerkUserId, ...profile });
    } else if (!existing.deletedAt && existing.updatedAt <= profile.updatedAt) {
      // Replace, not patch, so a field cleared in Clerk is cleared here too.
      await ctx.db.replace("users", existing._id, { clerkUserId, ...profile });
    } else {
      return;
    }

    await syncShowcaseOwner(ctx, clerkUserId, profile);
  },
});

/**
 * Showcase entries copy the owner's name and avatar at publish time; keep them
 * current. Bounded: a user with more entries than one batch keeps stale copies
 * on the rest until their next profile change.
 */
async function syncShowcaseOwner(
  ctx: MutationCtx,
  clerkUserId: string,
  profile: Pick<Doc<"users">, "name" | "imageUrl">,
) {
  const entries = await ctx.db
    .query("showcaseProjects")
    .withIndex("by_owner", (q) => q.eq("ownerId", clerkUserId))
    .take(CASCADE_BATCH_SIZE);

  for (const entry of entries) {
    await ctx.db.patch("showcaseProjects", entry._id, {
      ownerName: profile.name ?? entry.ownerName,
      ownerAvatarUrl: profile.imageUrl,
    });
  }
}

/**
 * Applies a `user.deleted` event: tombstones the row (dropping profile data)
 * and starts the purge. Also handles users who never had a row, e.g. accounts
 * created before the webhook existed.
 */
export const markDeleted = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const now = Date.now();
    const existing = await getByClerkUserId(ctx, clerkUserId);

    if (existing) {
      await ctx.db.replace("users", existing._id, {
        clerkUserId,
        deletedAt: existing.deletedAt ?? now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("users", {
        clerkUserId,
        deletedAt: now,
        updatedAt: now,
      });
    }

    await ctx.scheduler.runAfter(0, internal.users.purgeUserData, {
      clerkUserId,
    });
  },
});

/**
 * Deletes everything a user owns, one bounded batch per run, rescheduling
 * itself until nothing is left. Tables that store user-owned data must be
 * added here (project-scoped tables belong in `projectCascade.ts`).
 */
export const purgeUserData = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const finished = await purgeUserDataBatch(ctx, clerkUserId);
    if (!finished) {
      await ctx.scheduler.runAfter(0, internal.users.purgeUserData, {
        clerkUserId,
      });
    }
  },
});

async function purgeUserDataBatch(
  ctx: MutationCtx,
  userId: string,
): Promise<boolean> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .first();
  if (project) {
    await deleteProjectBatch(ctx, project._id);
    return false;
  }

  // Normally removed with their project; this catches any left behind.
  const showcase = await ctx.db
    .query("showcaseProjects")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .first();
  if (showcase) {
    await deleteShowcaseBatch(ctx, showcase);
    return false;
  }

  // Votes on other people's entries: take the vote back out of their score.
  const votes = await ctx.db
    .query("showcaseVotes")
    .withIndex("by_userId_and_showcaseProjectId", (q) => q.eq("userId", userId))
    .take(CASCADE_BATCH_SIZE);
  for (const vote of votes) {
    const entry = await ctx.db.get("showcaseProjects", vote.showcaseProjectId);
    if (entry) {
      const field = vote.vote === "up" ? "upvotes" : "downvotes";
      await ctx.db.patch("showcaseProjects", entry._id, {
        [field]: Math.max(0, entry[field] - 1),
      });
    }
  }
  if (await deleteRows(ctx, "showcaseVotes", votes)) return false;

  const views = await ctx.db
    .query("showcaseViews")
    .withIndex("by_userId_and_showcaseProjectId", (q) => q.eq("userId", userId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "showcaseViews", views)) return false;

  const connection = await ctx.db
    .query("userConnections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (connection) {
    const links = await ctx.db
      .query("projectConnections")
      .withIndex("by_userConnection", (q) =>
        q.eq("userConnectionId", connection._id),
      )
      .take(CASCADE_BATCH_SIZE);
    if (!(await deleteRows(ctx, "projectConnections", links))) {
      await ctx.db.delete("userConnections", connection._id);
    }
    return false;
  }

  const flowStates = await ctx.db
    .query("oauthFlowStates")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "oauthFlowStates", flowStates)) return false;

  const aiPreferences = await ctx.db
    .query("userAiPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "userAiPreferences", aiPreferences)) return false;

  const aiProviderKeys = await ctx.db
    .query("aiProviderKeys")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "aiProviderKeys", aiProviderKeys)) return false;

  return true;
}
