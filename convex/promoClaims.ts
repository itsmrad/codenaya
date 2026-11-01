import { v } from "convex/values";

import {
  isGithubAccountOldEnough,
  isPromoActive,
  promoRunRefusal,
} from "../src/features/promotions/github-promo";
import { QueryCtx, mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";

/**
 * The GitHub launch promotion (ADR 0009). Claims are written by
 * `POST /api/promotions/claim`, the only caller that has verified the GitHub
 * account with GitHub itself; runs are counted by the send routes, after their
 * ownership checks and before they create anything. Both hold the internal
 * key. The rules live in `features/promotions/github-promo.ts`.
 */

const claimForUser = (ctx: QueryCtx, userId: string) =>
  ctx.db
    .query("promoClaims")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

const promoModelKindValidator = v.union(v.literal("opus"), v.literal("sonnet"));

/** The caller's claim, for the promo page, the banner and the model picker. */
export const getMine = query({
  args: {},
  returns: v.union(
    v.object({
      githubLogin: v.string(),
      opusRunsUsed: v.number(),
      claimedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    const claim = await claimForUser(ctx, identity.subject);
    return (
      claim && {
        githubLogin: claim.githubLogin,
        opusRunsUsed: claim.opusRunsUsed,
        claimedAt: claim.claimedAt,
      }
    );
  },
});

/**
 * Records `userId`'s claim. The GitHub fields come from GitHub's own API with
 * the user's linked token, read by the route; the age and the end date are
 * checked again here, where the clock and the uniqueness checks are atomic.
 */
export const claim = mutation({
  args: {
    internalKey: v.string(),
    userId: v.string(),
    githubUserId: v.number(),
    githubLogin: v.string(),
    githubCreatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, userId, githubUserId, githubLogin, githubCreatedAt }) => {
    validateInternalKey(internalKey);
    const now = Date.now();
    if (!isPromoActive(now)) {
      throw appError("CONFLICT", "The promotion has ended", { reason: "promo_ended" });
    }
    if (!isGithubAccountOldEnough(githubCreatedAt, now)) {
      throw appError("FORBIDDEN", "GitHub account is too new", { reason: "github_too_new" });
    }
    if (await claimForUser(ctx, userId)) {
      throw appError("CONFLICT", "Already claimed", { reason: "already_claimed" });
    }
    const githubClaim = await ctx.db
      .query("promoClaims")
      .withIndex("by_githubUserId", (q) => q.eq("githubUserId", githubUserId))
      .first();
    if (githubClaim) {
      throw appError("CONFLICT", "GitHub account already used", { reason: "github_already_used" });
    }

    await ctx.db.insert("promoClaims", {
      userId,
      githubUserId,
      githubLogin,
      githubCreatedAt,
      opusRunsUsed: 0,
      claimedAt: now,
    });
    return null;
  },
});

/**
 * `userId`'s Opus run count, or null without a claim, for the send's
 * read-only check: `promoRunRefusal` in the route applies the rules, so the
 * query never reads the clock.
 */
export const getForServer = query({
  args: { internalKey: v.string(), userId: v.string() },
  returns: v.union(v.object({ opusRunsUsed: v.number() }), v.null()),
  handler: async (ctx, { internalKey, userId }) => {
    validateInternalKey(internalKey);
    const claim = await claimForUser(ctx, userId);
    return claim && { opusRunsUsed: claim.opusRunsUsed };
  },
});

/**
 * Takes one promo run for `userId` before a send creates its messages. An Opus
 * run is counted here, in the same transaction as the check, so two sends
 * racing for the last run can't both get it. Returns why it was refused, or
 * null when the run may go ahead.
 */
export const takeRun = mutation({
  args: { internalKey: v.string(), userId: v.string(), kind: promoModelKindValidator },
  returns: v.union(
    v.literal("not_claimed"),
    v.literal("ended"),
    v.literal("opus_used_up"),
    v.null(),
  ),
  handler: async (ctx, { internalKey, userId, kind }) => {
    validateInternalKey(internalKey);
    const claim = await claimForUser(ctx, userId);
    if (!claim) return "not_claimed";
    const refusal = promoRunRefusal(claim, { kind }, Date.now());
    if (refusal) return refusal;
    if (kind === "opus") {
      await ctx.db.patch("promoClaims", claim._id, { opusRunsUsed: claim.opusRunsUsed + 1 });
    }
    return null;
  },
});

/**
 * Gives back an Opus run `takeRun` counted for a send that then failed to
 * dispatch, so retrying it doesn't cost a second run.
 */
export const refundRun = mutation({
  args: { internalKey: v.string(), userId: v.string(), kind: promoModelKindValidator },
  returns: v.null(),
  handler: async (ctx, { internalKey, userId, kind }) => {
    validateInternalKey(internalKey);
    const claim = await claimForUser(ctx, userId);
    if (claim && kind === "opus" && claim.opusRunsUsed > 0) {
      await ctx.db.patch("promoClaims", claim._id, { opusRunsUsed: claim.opusRunsUsed - 1 });
    }
    return null;
  },
});

/**
 * Whether the project's owner has claimed, for the agent run: the event is
 * the boundary it trusts, so it re-checks the claim (not the count, which the
 * send already took) rather than taking the model at its word.
 */
export const hasClaimForProjectOwner = query({
  args: { internalKey: v.string(), projectId: v.id("projects") },
  returns: v.boolean(),
  handler: async (ctx, { internalKey, projectId }) => {
    validateInternalKey(internalKey);
    const project = await ctx.db.get("projects", projectId);
    return Boolean(project && (await claimForUser(ctx, project.ownerId)));
  },
});
