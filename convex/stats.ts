import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * Public totals for the landing page, read from denormalized `counters` rows
 * so each read is a single indexed lookup instead of a table scan.
 */

const PROJECTS_BUILT = "projectsBuilt";
const BACKFILL_BATCH = 500;
/**
 * The total is split over this many rows so concurrent project creations
 * rarely patch the same one (a single hot row made them OCC-retry, #597).
 * Shard 0 keeps the original name, so an existing total stays counted.
 * shortcut: fixed shard count; widen SHARDS (readers sum by name) if creates still collide.
 */
const SHARDS = 8;

const shardName = (i: number) => (i === 0 ? PROJECTS_BUILT : `${PROJECTS_BUILT}:${i}`);

const getShardRow = (ctx: QueryCtx, i: number) =>
  ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", shardName(i)))
    .unique();

async function getShardRows(ctx: QueryCtx) {
  const rows = await Promise.all(Array.from({ length: SHARDS }, (_, i) => getShardRow(ctx, i)));
  return rows.filter((row): row is Doc<"counters"> => row !== null);
}

/**
 * Adds one to the "projects built" total. Call it in the same mutation as
 * every `projects` insert so the counter can never drift. Deleting a project
 * does not lower it: the number counts projects ever built, not live ones.
 */
export async function countProjectBuilt(ctx: MutationCtx) {
  const shard = Math.floor(Math.random() * SHARDS);
  const counter = await getShardRow(ctx, shard);
  if (counter) {
    await ctx.db.patch("counters", counter._id, { value: counter.value + 1 });
  } else {
    await ctx.db.insert("counters", { name: shardName(shard), value: 1 });
  }
}

/** The "N projects built" total, or null before anything has been counted. */
export const projectsBuilt = query({
  args: {},
  returns: v.union(v.number(), v.null()),
  handler: async (ctx) => {
    const rows = await getShardRows(ctx);
    return rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.value, 0);
  },
});

/**
 * Recounts existing projects into the counter, a batch per run. Run once
 * after deploying the counter:
 * `npx convex run stats:backfillProjectsBuilt '{}'`. The final batch writes the
 * total in the same transaction that sees the end of the table, so projects
 * created while it runs are counted exactly once.
 */
export const backfillProjectsBuilt = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    counted: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("projects")
      .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_BATCH });
    const counted = (args.counted ?? 0) + page.page.length;

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.stats.backfillProjectsBuilt, {
        cursor: page.continueCursor,
        counted,
      });
      return null;
    }

    // The whole total goes in shard 0; stale values in the others are zeroed.
    const rows = await getShardRows(ctx);
    const first = rows.find((row) => row.name === PROJECTS_BUILT);
    if (first) await ctx.db.patch("counters", first._id, { value: counted });
    else await ctx.db.insert("counters", { name: PROJECTS_BUILT, value: counted });
    for (const row of rows) {
      if (row !== first) await ctx.db.patch("counters", row._id, { value: 0 });
    }
    return null;
  },
});
