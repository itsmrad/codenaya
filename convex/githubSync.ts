import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { MAX_CHECKPOINTS_PER_PROJECT } from "./checkpoints";
import { getOwnedProject } from "./projects";

/**
 * GitHub sync (#343): a push turns the agent runs since the last sync into
 * commits, one per run. More runs than this can't all still have the
 * checkpoint their tree comes from, so the push falls back to one commit.
 */
export const MAX_PUSH_RUNS = MAX_CHECKPOINTS_PER_PROJECT;

/** When the commits the next push builds on were made. */
export const syncedAt = (sync: NonNullable<Doc<"projects">["githubSync"]>) =>
  sync.syncBranchAt ?? sync.lastSyncedAt;

/**
 * Finished agent runs that may have written files since `since`, oldest
 * first, at most MAX_PUSH_RUNS. Plan-mode replies wrote nothing. `more` is set
 * when there are runs past those.
 */
export async function runsSince(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  since: number,
) {
  const finished = (status: "completed" | "cancelled") =>
    ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", projectId).eq("status", status).gt("_creationTime", since),
      )
      .take(MAX_PUSH_RUNS + 1);
  const batches = [await finished("completed"), await finished("cancelled")];
  const runs = batches
    .flat()
    .filter((message) => message.role === "assistant" && message.mode !== "plan")
    .sort((a, b) => a._creationTime - b._creationTime);
  return {
    runs: runs.slice(0, MAX_PUSH_RUNS),
    more: runs.length > MAX_PUSH_RUNS || batches.some((batch) => batch.length > MAX_PUSH_RUNS),
  };
}

/** Runs not pushed yet, for the export button's dot. Null when not linked. */
export const unpushedRuns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);
    if (!project.githubSync) return null;
    const { runs, more } = await runsSince(ctx, project._id, syncedAt(project.githubSync));
    return { count: runs.length, more };
  },
});
