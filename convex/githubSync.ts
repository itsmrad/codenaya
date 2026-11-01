import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import {
  MAX_CHECKPOINTS_PER_PROJECT,
  applyTree,
  assertNoRunningAgent,
  createCheckpoint,
} from "./checkpoints";
import { validateInternalKey } from "./internalKey";
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

/**
 * Runs not pushed yet, for the export button's dot, and whether one is still
 * running (its edits would land in a later run's commit). Null when not linked.
 */
export const unpushedRuns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);
    if (!project.githubSync) return null;
    const { runs, more } = await runsSince(ctx, project._id, syncedAt(project.githubSync));
    const running = await ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", project._id).eq("status", "processing"),
      )
      .first();
    return { count: runs.length, more, running: running !== null };
  },
});

const treeEntryValidator = v.object({
  path: v.string(),
  type: v.union(v.literal("file"), v.literal("folder")),
  content: v.optional(v.string()),
  storageId: v.optional(v.id("_storage")),
});

/** "Before pull" (#343): a checkpoint with no run, so the pull can be undone. */
export const createPullCheckpoint = mutation({
  args: { internalKey: v.string(), projectId: v.id("projects"), label: v.string() },
  returns: v.id("checkpoints"),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await assertNoRunningAgent(ctx, args.projectId, "pulling");
    return await createCheckpoint(ctx, { projectId: args.projectId, label: args.label });
  },
});

/** One batch of a pull (#343): writes these files over the project's, deleting none. */
export const applyPulledFiles = mutation({
  args: { internalKey: v.string(), projectId: v.id("projects"), entries: v.array(treeEntryValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await assertNoRunningAgent(ctx, args.projectId, "pulling");
    await applyTree(ctx, args.projectId, args.entries);
    return null;
  },
});

/**
 * Ends a pull (#343): deletes what the pulled tree doesn't have and moves the
 * sync point to the pulled commit, so later pushes build on it.
 */
export const finishPull = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    tree: v.array(v.object({ path: v.string(), type: treeEntryValidator.fields.type })),
    sha: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const project = await ctx.db.get("projects", args.projectId);
    if (!project?.githubSync) throw new Error("Project is not linked to a GitHub repository");
    await assertNoRunningAgent(ctx, args.projectId, "pulling");
    await applyTree(ctx, args.projectId, [], new Map(args.tree.map(({ path, type }) => [path, type])));
    const { repo, branch } = project.githubSync;
    await ctx.db.patch("projects", args.projectId, {
      githubSync: { repo, branch, lastSyncedSha: args.sha, lastSyncedAt: Date.now() },
    });
    return null;
  },
});
