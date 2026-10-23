import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { type Infer, v } from "convex/values";

import {
  MAX_TOKENS_PER_CALL,
  UNPRICED_FALLBACK_PRICE,
  type UsageStatus,
  costMicroUsd,
  monthKey,
  usageStatus,
} from "../src/features/ai-usage/limits";
import { MAX_MODEL_ID_LENGTH } from "../src/features/ai-providers/registry";
import type { PlanId } from "../src/features/billing/plans";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireAdmin } from "./admin";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { limitsFor, userPlanId } from "./planLimits";
import {
  aiUsageSourceValidator,
  planIdValidator,
  platformProviderValidator,
  usageStatusValidator,
} from "./schema";

/**
 * The platform AI usage ledger: one event per model call (dedupe by `key`)
 * and one aggregate per user per month, which every limit check reads. BYOK
 * calls are never recorded; callers skip them at the source.
 */

const MAX_KEY_LENGTH = 200;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const getMonthly = (ctx: QueryCtx, userId: string, month: string) =>
  ctx.db
    .query("aiUsageMonthly")
    .withIndex("by_userId_and_month", (q) => q.eq("userId", userId).eq("month", month))
    .unique();

/** Usage against the user's plan caps. Three point reads; the hot-path check. */
export async function usageStatusFor(ctx: QueryCtx, userId: string, month: string): Promise<UsageStatus> {
  const planId = await userPlanId(ctx, userId);
  const [limits, monthly] = await Promise.all([limitsFor(ctx, planId), getMonthly(ctx, userId, month)]);
  return usageStatus(planId, limits, {
    costMicroUsd: monthly?.costMicroUsd ?? 0,
    tokens: (monthly?.inputTokens ?? 0) + (monthly?.outputTokens ?? 0),
  });
}

/**
 * The price of a call on `provider`: the model's saved price, else the
 * default model's (the title and editor models are rarely listed; this
 * overestimates). No saved selection: null, charged at the fallback rate.
 */
async function priceFor(
  ctx: QueryCtx,
  provider: Infer<typeof platformProviderValidator>,
  modelId: string,
) {
  const config = await ctx.db
    .query("platformModelConfigs")
    .withIndex("by_provider", (q) => q.eq("provider", provider))
    .unique();
  return (
    config?.models.find((m) => m.id === modelId) ??
    config?.models.find((m) => m.id === config.defaultModelId) ??
    null
  );
}

const isTokenCount = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_TOKENS_PER_CALL;

/**
 * Records one platform model call and returns the user's status after it.
 * Idempotent by `key`: a call already recorded writes nothing, so an Inngest
 * retry or replay can't count twice. The event and the monthly total commit
 * together. Concurrent runs of one user contend on the monthly doc; Convex
 * retries that (OCC), and a user has at most two runs at once.
 */
export const record = mutation({
  args: {
    internalKey: v.string(),
    key: v.string(),
    userId: v.string(),
    source: aiUsageSourceValidator,
    provider: platformProviderValidator,
    modelId: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  },
  returns: usageStatusValidator,
  handler: async (ctx, { internalKey, inputTokens, outputTokens, ...call }) => {
    validateInternalKey(internalKey);
    if (!call.key || call.key.length > MAX_KEY_LENGTH) throw appError("INVALID_ARGUMENT", "Invalid usage key");
    if (!call.userId || call.userId.length > MAX_KEY_LENGTH) throw appError("INVALID_ARGUMENT", "Invalid user");
    if (!call.modelId || call.modelId.length > MAX_MODEL_ID_LENGTH) {
      throw appError("INVALID_ARGUMENT", "Invalid model id");
    }
    if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
      throw appError("INVALID_ARGUMENT", "Invalid token count");
    }

    const now = Date.now();
    const month = monthKey(now);
    const seen = await ctx.db
      .query("aiUsageEvents")
      .withIndex("by_key", (q) => q.eq("key", call.key))
      .unique();
    if (seen) return await usageStatusFor(ctx, seen.userId, seen.month);

    // Unpriced is never free: the fallback rate keeps the USD cap working.
    const price = await priceFor(ctx, call.provider, call.modelId);
    const cost = costMicroUsd(inputTokens, outputTokens, price ?? UNPRICED_FALLBACK_PRICE);
    await ctx.db.insert("aiUsageEvents", {
      ...call,
      month,
      inputTokens,
      outputTokens,
      costMicroUsd: cost,
      priced: price !== null,
      at: now,
    });

    const monthly = await getMonthly(ctx, call.userId, month);
    if (monthly) {
      await ctx.db.patch("aiUsageMonthly", monthly._id, {
        costMicroUsd: monthly.costMicroUsd + cost,
        inputTokens: monthly.inputTokens + inputTokens,
        outputTokens: monthly.outputTokens + outputTokens,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("aiUsageMonthly", {
        userId: call.userId,
        month,
        costMicroUsd: cost,
        inputTokens,
        outputTokens,
        updatedAt: now,
      });
    }
    return await usageStatusFor(ctx, call.userId, month);
  },
});

const assertMonth = (month: string) => {
  if (!MONTH_PATTERN.test(month)) throw appError("INVALID_ARGUMENT", "Invalid month");
};

/** A user's status, for the run's start check. `month` is passed: queries can't read the clock. */
export const checkLimit = query({
  args: { internalKey: v.string(), userId: v.string(), month: v.string() },
  returns: usageStatusValidator,
  handler: async (ctx, { internalKey, userId, month }) => {
    validateInternalKey(internalKey);
    assertMonth(month);
    return await usageStatusFor(ctx, userId, month);
  },
});

/** The caller's own usage this month, for the settings page. */
export const myUsage = query({
  args: { month: v.string() },
  returns: usageStatusValidator,
  handler: async (ctx, { month }) => {
    const identity = await verifyAuth(ctx);
    assertMonth(month);
    return await usageStatusFor(ctx, identity.subject, month);
  },
});

/** The month's biggest spenders first, with who they are and their caps. */
export const listTopSpenders = query({
  args: { month: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      userId: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      planId: planIdValidator,
      costMicroUsd: v.number(),
      tokens: v.number(),
      costLimitMicroUsd: v.optional(v.number()),
      tokenLimit: v.optional(v.number()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, { month, paginationOpts }) => {
    await requireAdmin(ctx);
    assertMonth(month);
    const result = await ctx.db
      .query("aiUsageMonthly")
      .withIndex("by_month_and_costMicroUsd", (q) => q.eq("month", month))
      .order("desc")
      .paginate(paginationOpts);

    // One page of point reads; plan caps are read once per plan.
    const limitsByPlan = new Map<PlanId, ReturnType<typeof limitsFor>>();
    const page = await Promise.all(
      result.page.map(async (row) => {
        const planId = await userPlanId(ctx, row.userId);
        if (!limitsByPlan.has(planId)) limitsByPlan.set(planId, limitsFor(ctx, planId));
        const [user, limits] = await Promise.all([
          ctx.db
            .query("users")
            .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", row.userId))
            .unique(),
          limitsByPlan.get(planId)!,
        ]);
        return {
          userId: row.userId,
          ...(user?.email ? { email: user.email } : {}),
          ...(user?.name ? { name: user.name } : {}),
          planId,
          costMicroUsd: row.costMicroUsd,
          tokens: row.inputTokens + row.outputTokens,
          ...limits,
          updatedAt: row.updatedAt,
        };
      }),
    );
    return { ...result, page };
  },
});
