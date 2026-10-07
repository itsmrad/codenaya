import { v } from "convex/values";

import { internal } from "./_generated/api";
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

const getProjectsBuiltRow = (ctx: QueryCtx) =>
  ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", PROJECTS_BUILT))
    .unique();

async function setProjectsBuilt(ctx: MutationCtx, value: (current: number) => number) {
  const counter = await getProjectsBuiltRow(ctx);
  if (counter) {
    await ctx.db.patch("counters", counter._id, { value: value(counter.value) });
  } else {
    await ctx.db.insert("counters", { name: PROJECTS_BUILT, value: value(0) });
  }
}

/**
 * Adds one to the "projects built" total. Call it in the same mutation as
 * every `projects` insert so the counter can never drift. Deleting a project
 * does not lower it: the number counts projects ever built, not live ones.
 */
export async function countProjectBuilt(ctx: MutationCtx) {
  await setProjectsBuilt(ctx, (current) => current + 1);
}

/** The "N projects built" total, or null before anything has been counted. */
export const projectsBuilt = query({
  args: {},
  returns: v.union(v.number(), v.null()),
  handler: async (ctx) => {
    const counter = await getProjectsBuiltRow(ctx);
    return counter?.value ?? null;
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

    await setProjectsBuilt(ctx, () => counted);
    return null;
  },
});
