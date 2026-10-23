import { v } from "convex/values";

import {
  MAX_MONTHLY_TOKEN_LIMIT,
  MAX_MONTHLY_USD_LIMIT,
  type PlanLimits,
  defaultPlanLimits,
  formatTokens,
  formatUsd,
  usdToMicro,
} from "../src/features/ai-usage/limits";
import { PLANS, type PlanId } from "../src/features/billing/plans";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireAdmin, writeAudit } from "./admin";
import { appError } from "./errors";
import { planIdValidator } from "./schema";

/**
 * Per-plan monthly caps on platform AI (/admin → Usage). Usage itself is in
 * `aiUsage.ts`.
 */

/**
 * The only answer to "which plan is this user on". Everyone is on Free until
 * billing (#105) stores a plan.
 * ponytail: a constant on purpose; #105 replaces the body with its plan read
 * and no caller changes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the arguments #105 reads
export const userPlanId = async (_ctx: QueryCtx, _userId: string): Promise<PlanId> => "free";

const getRow = (ctx: QueryCtx, planId: PlanId) =>
  ctx.db
    .query("planLimits")
    .withIndex("by_planId", (q) => q.eq("planId", planId))
    .unique();

const capsOf = (row: { costLimitMicroUsd?: number; tokenLimit?: number }): PlanLimits => ({
  ...(row.costLimitMicroUsd !== undefined ? { costLimitMicroUsd: row.costLimitMicroUsd } : {}),
  ...(row.tokenLimit !== undefined ? { tokenLimit: row.tokenLimit } : {}),
});

/** The plan's saved caps, else its `PLANS` default; never unlimited by omission. */
export const limitsFor = async (ctx: QueryCtx, planId: PlanId): Promise<PlanLimits> => {
  const row = await getRow(ctx, planId);
  return row ? capsOf(row) : defaultPlanLimits(planId);
};

const PLAN_IDS = Object.keys(PLANS) as PlanId[];

/** Every plan's effective caps, for the /admin editor. Reads one row per plan. */
export const listPlanLimits = query({
  args: {},
  returns: v.array(
    v.object({
      planId: planIdValidator,
      costLimitMicroUsd: v.optional(v.number()),
      tokenLimit: v.optional(v.number()),
      isDefault: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await Promise.all(
      PLAN_IDS.map(async (planId) => {
        const row = await getRow(ctx, planId);
        return { planId, ...(row ? capsOf(row) : defaultPlanLimits(planId)), isDefault: !row };
      }),
    );
  },
});

const describeLimits = (limits: PlanLimits) =>
  `USD ${limits.costLimitMicroUsd === undefined ? "none" : formatUsd(limits.costLimitMicroUsd)}, ` +
  `tokens ${limits.tokenLimit === undefined ? "none" : formatTokens(limits.tokenLimit)}`;

/**
 * Sets a plan's caps (an omitted cap means none) and audits the change, in one
 * transaction. USD is stored as micro-USD.
 */
export const setPlanLimits = mutation({
  args: {
    planId: planIdValidator,
    monthlyUsdLimit: v.optional(v.number()),
    monthlyTokenLimit: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { planId, monthlyUsdLimit, monthlyTokenLimit }) => {
    const admin = await requireAdmin(ctx);
    if (
      monthlyUsdLimit !== undefined &&
      !(Number.isFinite(monthlyUsdLimit) && monthlyUsdLimit >= 0 && monthlyUsdLimit <= MAX_MONTHLY_USD_LIMIT)
    ) {
      throw appError("INVALID_ARGUMENT", `The USD limit must be between $0 and $${MAX_MONTHLY_USD_LIMIT}`);
    }
    if (
      monthlyTokenLimit !== undefined &&
      !(Number.isInteger(monthlyTokenLimit) && monthlyTokenLimit >= 0 && monthlyTokenLimit <= MAX_MONTHLY_TOKEN_LIMIT)
    ) {
      throw appError(
        "INVALID_ARGUMENT",
        `The token limit must be a whole number between 0 and ${formatTokens(MAX_MONTHLY_TOKEN_LIMIT)}`,
      );
    }

    const next: PlanLimits = {
      ...(monthlyUsdLimit !== undefined ? { costLimitMicroUsd: usdToMicro(monthlyUsdLimit) } : {}),
      ...(monthlyTokenLimit !== undefined ? { tokenLimit: monthlyTokenLimit } : {}),
    };
    const row = await getRow(ctx, planId);
    const before = row ? capsOf(row) : defaultPlanLimits(planId);
    const fields = { planId, ...next, updatedAt: Date.now(), updatedBy: admin.id };
    if (row) {
      // replace, not patch: a cap turned off must disappear from the row.
      await ctx.db.replace("planLimits", row._id, fields);
    } else {
      await ctx.db.insert("planLimits", fields);
    }

    await writeAudit(
      ctx,
      admin,
      "planLimits.set",
      `${PLANS[planId].name}: ${describeLimits(before)} → ${describeLimits(next)}${row ? "" : " (was the default)"}`,
    );
    return null;
  },
});
