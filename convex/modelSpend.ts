import { v } from "convex/values";

import { MAX_PLATFORM_MODELS } from "../src/features/admin/platform-models";
import { spendPeriodStart, spentInPeriod } from "../src/features/billing/model-spend";
import { type MutationCtx, type QueryCtx, query } from "./_generated/server";
import { requireAdmin } from "./admin";
import { validateInternalKey } from "./internalKey";

/**
 * Per-model spend limits (ADR 0012). `credits.recordRunUsage` adds each run's
 * cost here as it grows; the send routes read it to refuse a model past its
 * cap. The rules live in `features/billing/model-spend.ts`.
 */

const spendRow = (ctx: QueryCtx, userId: string | null, modelId: string) =>
  ctx.db
    .query("modelSpend")
    .withIndex("by_userId_modelId", (q) => q.eq("userId", userId).eq("modelId", modelId))
    .unique();

const spendRowValidator = v.union(v.object({ periodStartsAt: v.number(), spentUsd: v.number() }), v.null());

const rowView = (row: { periodStartsAt: number; spentUsd: number } | null) =>
  row && { periodStartsAt: row.periodStartsAt, spentUsd: row.spentUsd };

/** `userId`'s and the whole site's spend on `modelId`, for the send's limit check. */
export const getForServer = query({
  args: { internalKey: v.string(), userId: v.string(), modelId: v.string() },
  returns: v.object({ user: spendRowValidator, total: spendRowValidator }),
  handler: async (ctx, { internalKey, userId, modelId }) => {
    validateInternalKey(internalKey);
    const [user, total] = await Promise.all([spendRow(ctx, userId, modelId), spendRow(ctx, null, modelId)]);
    return { user: rowView(user), total: rowView(total) };
  },
});

/** Site-wide spend per model as stored, for /admin. The client applies the period. */
export const listTotalsForAdmin = query({
  args: {},
  returns: v.array(v.object({ modelId: v.string(), periodStartsAt: v.number(), spentUsd: v.number() })),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // Rows of removed models stay, so leave room beyond the catalog's size.
    const rows = await ctx.db
      .query("modelSpend")
      .withIndex("by_userId_modelId", (q) => q.eq("userId", null))
      .take(MAX_PLATFORM_MODELS * 4);
    return rows.map(({ modelId, periodStartsAt, spentUsd }) => ({ modelId, periodStartsAt, spentUsd }));
  },
});

/**
 * Adds `usd` to `userId`'s and the site's spend on `modelId`, when the
 * catalog limits that model; a period that has ended starts again from 0.
 */
export async function addModelSpend(ctx: MutationCtx, userId: string, modelId: string, usd: number, now: number) {
  const catalog = await ctx.db.query("platformCatalog").first();
  const limit = catalog?.models.find((model) => model.id === modelId)?.spendLimit;
  if (!limit) return;
  const periodStartsAt = spendPeriodStart(limit.resets, now);
  for (const owner of [userId, null]) {
    const row = await spendRow(ctx, owner, modelId);
    const spentUsd = spentInPeriod(row, periodStartsAt) + usd;
    if (row) {
      await ctx.db.patch("modelSpend", row._id, { periodStartsAt, spentUsd });
    } else {
      await ctx.db.insert("modelSpend", { userId: owner, modelId, periodStartsAt, spentUsd });
    }
  }
}
