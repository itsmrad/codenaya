import { v } from "convex/values";

import { creditsForCost, currentUsage } from "../src/features/billing/credits";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { spendPaidCredits } from "./billingGrants";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { addModelSpend } from "./modelSpend";
import { planIdValidator, runSourceValidator } from "./schema";
import { MAX_SWARM_TASKS } from "./swarm";

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

/**
 * Credits the caller was charged for one run (#526): its own row plus one per
 * swarm worker. Null when nothing was recorded for them, e.g. another user's run.
 */
export const getRunCredits = query({
  args: { messageId: v.id("messages") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { messageId }) => {
    const identity = await verifyAuth(ctx);
    const rows = await ctx.db
      .query("creditLedger")
      .withIndex("by_messageId_and_agentTaskId", (q) => q.eq("messageId", messageId))
      .take(MAX_SWARM_TASKS + 1);
    // The row's userId is the project owner, so this is the ownership check.
    const owned = rows.filter((row) => row.userId === identity.subject);
    return owned.length === 0 ? null : owned.reduce((sum, row) => sum + row.credits, 0);
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
    // Billing-enabled accounts (ADR 0016: version and mode set) also spend paid lots in this same transaction.
    const { paidCreditsVersion, paidCreditsMode } = account;
    const debt =
      paidCreditsVersion === undefined || paidCreditsMode === undefined
        ? 0
        : await spendPaidCredits(ctx, userId, paidCreditsMode, credits, now);
    await ctx.db.patch("creditAccounts", account._id, debt > 0 ? { ...next, creditDebt: (account.creditDebt ?? 0) + debt } : next);
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
    agentTaskId: v.optional(v.id("agentTasks")),
    // The model that actually ran, when it differs from the one the row names
    // (a swarm worker falls back to its run's model).
    modelId: v.optional(v.string()),
    model: v.optional(v.string()),
    source: runSourceValidator,
    inputTokens: v.number(),
    outputTokens: v.number(),
    // Parts of inputTokens; optional so an older caller still validates.
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    costUsd: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, messageId, agentTaskId, modelId: ranId, model: ranLabel, source, ...totals }) => {
    validateInternalKey(internalKey);
    if (!Object.values(totals).every((n) => n === undefined || (Number.isFinite(n) && n >= 0))) {
      throw appError("INVALID_ARGUMENT", "Usage totals must be finite and not negative");
    }
    const message = await ctx.db.get("messages", messageId);
    const project = message && (await ctx.db.get("projects", message.projectId));
    // The project was deleted mid-run: nobody left to charge.
    if (!message || !project) return null;

    const task = agentTaskId === undefined ? null : await ctx.db.get("agentTasks", agentTaskId);
    if (agentTaskId !== undefined && (!task || task.messageId !== messageId || task.projectId !== message.projectId)) {
      throw appError("INVALID_ARGUMENT", "Task does not belong to this message");
    }
    const modelId = ranId ?? (task ? task.modelId : message.runModel?.modelId);
    const model = ranLabel ?? (task ? task.model : message.runModel?.label ?? "");
    const row = await ctx.db
      .query("creditLedger")
      .withIndex("by_messageId_and_agentTaskId", (q) =>
        q.eq("messageId", messageId).eq("agentTaskId", agentTaskId),
      )
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
          cacheReadTokens: Math.max(row.cacheReadTokens ?? 0, totals.cacheReadTokens ?? 0),
          cacheWriteTokens: Math.max(row.cacheWriteTokens ?? 0, totals.cacheWriteTokens ?? 0),
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
        agentTaskId,
        source,
        model,
        ...fields,
      });
    }
    const added = credits - (row?.credits ?? 0);
    if (added > 0) {
      await chargeAccount(ctx, project.ownerId, added, now);
    }
    // Promo runs cost us too; the user's own key doesn't. shortcut: the run's
    // total includes its title on the utility model, a small overcount.
    const addedUsd = grown.costUsd - (row?.costUsd ?? 0);
    if (source !== "byok" && addedUsd > 0 && modelId) {
      await addModelSpend(ctx, project.ownerId, modelId, addedUsd, now);
    }
    return null;
  },
});

/**
 * Charges `userId` for one dictation transcribed on the platform key
 * (`/api/transcribe`). The route calls it once per request, after the provider
 * answered. shortcut: no ledger row, since the ledger is per run, and no
 * `addModelSpend`, so dictation is missing from usage history and from the
 * admin's site spend; add both if dictation spend starts to matter.
 */
export const recordTranscriptionUsage = mutation({
  args: { internalKey: v.string(), userId: v.string(), costUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, { internalKey, userId, costUsd }) => {
    validateInternalKey(internalKey);
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw appError("INVALID_ARGUMENT", "Cost must be finite and not negative");
    }
    const credits = creditsForCost(costUsd);
    if (credits > 0) {
      await chargeAccount(ctx, userId, credits, Date.now());
    }
    return null;
  },
});
