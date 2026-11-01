import { v } from "convex/values";

import { creditsForCost, currentUsage } from "../src/features/billing/credits";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { planIdValidator, runSourceValidator } from "./schema";

/**
 * Credit metering (ADR 0011). The send routes read the account to refuse a
 * platform run that has no credits left; the agent run records its usage after
 * every inference. Both hold the internal key. The rules live in
 * `features/billing/credits.ts`.
 */

const accountFor = (ctx: QueryCtx, userId: string) =>
  ctx.db
    .query("creditAccounts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

const accountValidator = v.object({
  plan: planIdValidator,
  periodStartsAt: v.number(),
  periodUsed: v.number(),
  dayStartsAt: v.number(),
  dayUsed: v.number(),
});

const accountView = (account: Doc<"creditAccounts"> | null) =>
  account && {
    plan: account.plan,
    periodStartsAt: account.periodStartsAt,
    periodUsed: account.periodUsed,
    dayStartsAt: account.dayStartsAt,
    dayUsed: account.dayUsed,
  };

/**
 * The caller's account as stored, or null before their first metered run. The
 * client applies `creditStanding` with its own clock: a query can't read one.
 */
export const getMine = query({
  args: {},
  returns: v.union(accountValidator, v.null()),
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    return accountView(await accountFor(ctx, identity.subject));
  },
});

/** `userId`'s account, for the send routes' credit check. */
export const getForServer = query({
  args: { internalKey: v.string(), userId: v.string() },
  returns: v.union(accountValidator, v.null()),
  handler: async (ctx, { internalKey, userId }) => {
    validateInternalKey(internalKey);
    return accountView(await accountFor(ctx, userId));
  },
});

/** Adds `credits` to the user's month and day, resetting a period that has ended. */
async function chargeAccount(ctx: MutationCtx, userId: string, credits: number, now: number) {
  const account = await accountFor(ctx, userId);
  const usage = currentUsage(account, now);
  const next = { ...usage, periodUsed: usage.periodUsed + credits, dayUsed: usage.dayUsed + credits };
  if (account) {
    await ctx.db.patch("creditAccounts", account._id, next);
  } else {
    await ctx.db.insert("creditAccounts", { userId, plan: "free", ...next });
  }
}

/**
 * Records an agent run's usage so far: the run's running totals, sent after
 * every inference so a cancelled or failed run is still charged for what it
 * used. Each total only grows (the row keeps the larger of old and new), so a
 * retried or replayed step changes nothing. Only the credits the new totals
 * add are charged. The owner comes from the message's project, not the caller.
 */
export const recordRunUsage = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    source: runSourceValidator,
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, messageId, source, ...totals }) => {
    validateInternalKey(internalKey);
    if (!Object.values(totals).every((n) => Number.isFinite(n) && n >= 0)) {
      throw appError("INVALID_ARGUMENT", "Usage totals must be finite and not negative");
    }
    const message = await ctx.db.get("messages", messageId);
    const project = message && (await ctx.db.get("projects", message.projectId));
    // The project was deleted mid-run: nobody left to charge.
    if (!message || !project) return null;

    const row = await ctx.db
      .query("creditLedger")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .unique();
    if (
      row &&
      totals.inputTokens <= row.inputTokens &&
      totals.outputTokens <= row.outputTokens &&
      totals.costUsd <= row.costUsd
    ) {
      return null;
    }

    const grown = row
      ? {
          inputTokens: Math.max(row.inputTokens, totals.inputTokens),
          outputTokens: Math.max(row.outputTokens, totals.outputTokens),
          costUsd: Math.max(row.costUsd, totals.costUsd),
        }
      : totals;
    const now = Date.now();
    const credits = source === "platform" ? creditsForCost(grown.costUsd) : 0;
    const fields = { ...grown, credits, updatedAt: now };
    if (row) {
      await ctx.db.patch("creditLedger", row._id, fields);
    } else {
      await ctx.db.insert("creditLedger", {
        userId: project.ownerId,
        messageId,
        source,
        model: message.runModel?.label ?? "",
        ...fields,
      });
    }
    const added = credits - (row?.credits ?? 0);
    if (added > 0) {
      await chargeAccount(ctx, project.ownerId, added, now);
    }
    return null;
  },
});
