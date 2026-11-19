import { v } from "convex/values";

import { MAX_ENV_VARS } from "../src/features/integrations/env-keys";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { getOwnedProject } from "./projects";
import schema from "./schema";

/**
 * Runtime admission fence for secret-bearing previews.
 *
 * The boot reads the env manifest and the project's `envGeneration` G in one
 * query, registers a `pending` handle at G before injecting any value, then
 * asks `admitRuntime`, which succeeds only while the project is live and still
 * at G. Every env change bumps the generation and marks every live handle
 * `stale` in the same transaction, so either admission loses (the boot aborts
 * and kills its sandbox) or the change sees the handle and marks it for a kill.
 */

/**
 * Live handles one project may hold. A boot replaces the earlier ones (see
 * `registerRuntime`), so a real project has a few; the cap makes "every live
 * handle" one bounded read.
 */
const MAX_LIVE_HANDLES = 20;

const LIVE_STATES = ["pending", "running"] as const;
/** Handles whose sandbox must be killed. */
const REVOKED_STATES = ["stale", "revoke_failed"] as const;

/** Revoked handles one sweep reads per state; the cron takes the rest a minute later. */
const SWEEP_BATCH = 25;

async function liveHandles(ctx: QueryCtx, projectId: Id<"projects">) {
  const pages = await Promise.all(
    LIVE_STATES.map((state) =>
      ctx.db
        .query("runtimeHandles")
        .withIndex("by_projectId_and_state", (q) => q.eq("projectId", projectId).eq("state", state))
        .take(MAX_LIVE_HANDLES),
    ),
  );
  return pages.flat();
}

/**
 * Outdates every running or starting secret runtime of a project. Call it in
 * the same transaction as any env save/delete or project delete (and, from
 * stage 7, a recovery-epoch change).
 */
export async function bumpEnvGeneration(ctx: MutationCtx, projectId: Id<"projects">) {
  const project = await ctx.db.get("projects", projectId);
  if (!project) return;
  await ctx.db.patch("projects", projectId, { envGeneration: (project.envGeneration ?? 0) + 1 });
  for (const handle of await liveHandles(ctx, projectId)) {
    await ctx.db.patch("runtimeHandles", handle._id, { state: "stale" });
  }
}

const envVarDoc = v.object({
  ...schema.tables.projectEnvVars.validator.fields,
  _id: v.id("projectEnvVars"),
  _creationTime: v.number(),
});

/**
 * Every variable for a boot, sealed payloads included, with the generation they
 * belong to. One query, so the two can't come from different env states.
 * `internalKey` only; null when the project is gone or being deleted.
 */
export const getBootManifest = query({
  args: { internalKey: v.string(), projectId: v.id("projects") },
  returns: v.union(v.null(), v.object({ generation: v.number(), records: v.array(envVarDoc) })),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const project = await ctx.db.get("projects", args.projectId);
    if (!project || project.deletingAt !== undefined) return null;
    const records = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_ENV_VARS);
    return { generation: project.envGeneration ?? 0, records };
  },
});

/**
 * Records a boot that is about to receive secrets, before it receives any.
 *
 * It drops the earlier live handles it replaces: a fresh boot
 * (`replacesPreviews`) has just killed every earlier preview of the project, and
 * a resume replaces its own sandbox's earlier boot. Dropped, not marked stale:
 * stale means "kill", and only an env change may kill another tab's preview.
 */
export const registerRuntime = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    ownerId: v.string(),
    sandboxId: v.string(),
    generation: v.number(),
    replacesPreviews: v.boolean(),
  },
  returns: v.id("runtimeHandles"),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await getOwnedProject(ctx, args.projectId, args.ownerId);

    const live = await liveHandles(ctx, args.projectId);
    const replaced = live.filter((handle) => args.replacesPreviews || handle.sandboxId === args.sandboxId);
    for (const handle of replaced) {
      await ctx.db.delete("runtimeHandles", handle._id);
    }
    if (live.length - replaced.length >= MAX_LIVE_HANDLES) {
      throw appError("LIMIT_EXCEEDED", "Too many previews of this project are starting at once");
    }

    return await ctx.db.insert("runtimeHandles", {
      projectId: args.projectId,
      sandboxId: args.sandboxId,
      generation: args.generation,
      state: "pending",
    });
  },
});

/**
 * Lets a registered boot start using its secrets: true only while the handle is
 * pending, the project is live, its envGeneration is still the handle's, and no
 * earlier runtime of the project failed to be killed. A refused handle is marked
 * stale, so its sandbox is killed even if the boot's own kill fails.
 */
export const admitRuntime = mutation({
  args: { internalKey: v.string(), handleId: v.id("runtimeHandles") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const handle = await ctx.db.get("runtimeHandles", args.handleId);
    if (!handle) return false;

    const project = await ctx.db.get("projects", handle.projectId);
    const unrevoked = await ctx.db
      .query("runtimeHandles")
      .withIndex("by_projectId_and_state", (q) => q.eq("projectId", handle.projectId).eq("state", "revoke_failed"))
      .first();
    const admitted =
      handle.state === "pending" &&
      project !== null &&
      project.deletingAt === undefined &&
      (project.envGeneration ?? 0) === handle.generation &&
      unrevoked === null;

    await ctx.db.patch("runtimeHandles", handle._id, { state: admitted ? "running" : "stale" });
    return admitted;
  },
});

/**
 * Handles whose sandbox must be killed, for one sandbox, one project, or (the
 * cron) any. `internalKey` only; at most SWEEP_BATCH per state.
 */
export const listRevokedHandles = query({
  args: {
    internalKey: v.string(),
    projectId: v.optional(v.id("projects")),
    sandboxId: v.optional(v.string()),
  },
  returns: v.array(v.object({ _id: v.id("runtimeHandles"), sandboxId: v.string() })),
  handler: async (ctx, { internalKey, projectId, sandboxId }) => {
    validateInternalKey(internalKey);
    const pages = await Promise.all(
      REVOKED_STATES.map((state) => {
        const handles = ctx.db.query("runtimeHandles");
        if (sandboxId !== undefined) {
          return handles
            .withIndex("by_sandboxId_and_state", (q) => q.eq("sandboxId", sandboxId).eq("state", state))
            .take(SWEEP_BATCH);
        }
        if (projectId !== undefined) {
          return handles
            .withIndex("by_projectId_and_state", (q) => q.eq("projectId", projectId).eq("state", state))
            .take(SWEEP_BATCH);
        }
        return handles.withIndex("by_state", (q) => q.eq("state", state)).take(SWEEP_BATCH);
      }),
    );
    return pages.flat().map(({ _id, sandboxId }) => ({ _id, sandboxId }));
  },
});

/** A revoked handle's kill: done removes it, a failure leaves it revoke_failed for the next sweep. */
export const recordKill = mutation({
  args: { internalKey: v.string(), handleId: v.id("runtimeHandles"), killed: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const handle = await ctx.db.get("runtimeHandles", args.handleId);
    if (!handle || (handle.state !== "stale" && handle.state !== "revoke_failed")) return null;
    if (args.killed) await ctx.db.delete("runtimeHandles", handle._id);
    else await ctx.db.patch("runtimeHandles", handle._id, { state: "revoke_failed" });
    return null;
  },
});
