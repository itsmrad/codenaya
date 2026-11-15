import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { mergeMessageSteps } from "./messageSteps";
import { getOwnedProject } from "./projects";
import schema, { agentTaskInputValidator, agentTaskStatusValidator, messageStepValidator } from "./schema";
import { MAX_SWARM_AGENTS, platformMaxDepth } from "./swarm";

/** Whether another of the owner's platform swarms has queued or running tasks under a running message. */
const otherPlatformSwarmRunning = async (ctx: QueryCtx, ownerId: string, messageId: Id<"messages">) => {
  const checked = new Set<Id<"messages">>([messageId]);
  for (const status of ["queued", "running"] as const) {
    // Newest first: a task left running under a cancelled message is older than any swarm started since.
    // shortcut: those stale rows are never cleaned up; finish them on cancel if they ever crowd this window.
    const rows = await ctx.db.query("agentTasks")
      .withIndex("by_ownerId_and_platform_and_status", (q) =>
        q.eq("ownerId", ownerId).eq("platform", true).eq("status", status))
      .order("desc")
      .take(2 * MAX_SWARM_AGENTS);
    for (const row of rows) {
      if (checked.has(row.messageId)) continue;
      checked.add(row.messageId);
      if ((await ctx.db.get("messages", row.messageId))?.status === "processing") return true;
    }
  }
  return false;
};

/**
 * Replays return the original rows without resetting their instructions or state.
 * A platform run (`byok` unset) gets sub-orchestrators only when SWARM_PLATFORM_MAX_DEPTH
 * allows them, and fans out only while no other platform swarm of the owner's runs.
 */
export const createTasks = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    projectId: v.id("projects"),
    tasks: v.array(agentTaskInputValidator),
    byok: v.optional(v.boolean()),
  },
  returns: v.array(v.id("agentTasks")),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const message = await ctx.db.get("messages", args.messageId);
    const project = await ctx.db.get("projects", args.projectId);
    if (!message || message.projectId !== args.projectId || !project || project.deletingAt !== undefined) {
      throw appError("NOT_FOUND", "Message not found");
    }
    if (message.role !== "assistant" || message.mode !== "swarm") {
      throw appError("INVALID_ARGUMENT", "Only a swarm reply can have tasks");
    }
    const platform = args.byok !== true;
    if (platform && platformMaxDepth() < 2 && args.tasks.some((task) => task.role === "sub-orchestrator")) {
      throw appError("INVALID_ARGUMENT", "Sub-orchestrators are off for platform models");
    }
    const existing = await ctx.db.query("agentTasks")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .take(MAX_SWARM_AGENTS + 1);
    let count = existing.length;
    const ids: Id<"agentTasks">[] = [];
    for (const task of args.tasks) {
      const row = await ctx.db.query("agentTasks")
        .withIndex("by_message_and_taskId", (q) => q.eq("messageId", args.messageId).eq("taskId", task.taskId))
        .unique();
      if (row) {
        ids.push(row._id);
        continue;
      }
      if (count >= MAX_SWARM_AGENTS) {
        throw appError("LIMIT_EXCEEDED", "Too many swarm agents");
      }
      // Checked once, before the first new row: a replay of created rows never trips it.
      if (platform && count === existing.length && await otherPlatformSwarmRunning(ctx, project.ownerId, args.messageId)) {
        throw appError("CONFLICT", "Another swarm is already running for this account");
      }
      ids.push(await ctx.db.insert("agentTasks", {
        ...task,
        messageId: args.messageId,
        projectId: args.projectId,
        ownerId: project.ownerId,
        platform,
        status: "queued",
        steps: [],
        updatedAt: Date.now(),
      }));
      count++;
    }
    return ids;
  },
});

export const upsertTaskSteps = mutation({
  args: { internalKey: v.string(), agentTaskId: v.id("agentTasks"), steps: v.array(messageStepValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const task = await ctx.db.get("agentTasks", args.agentTaskId);
    // The project may have been deleted mid-run; a finished task's steps are final.
    if (!task || task.status === "done" || task.status === "error") return null;
    await ctx.db.patch("agentTasks", task._id, {
      steps: mergeMessageSteps(task.steps, args.steps),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Hands the worker its task: its event carries ids only. Replays return the
 * row as it stands without restarting it.
 */
export const startTask = mutation({
  args: {
    internalKey: v.string(),
    agentTaskId: v.id("agentTasks"),
    parentMessageId: v.id("messages"),
    projectId: v.id("projects"),
  },
  returns: agentTaskInputValidator.omit("parentTaskId").extend({
    messageId: v.id("messages"),
    projectId: v.id("projects"),
    status: agentTaskStatusValidator,
  }),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const task = await ctx.db.get("agentTasks", args.agentTaskId);
    if (!task || task.messageId !== args.parentMessageId || task.projectId !== args.projectId) {
      throw appError("NOT_FOUND", "Task not found");
    }
    let status = task.status;
    if (status === "queued") {
      const now = Date.now();
      status = "running";
      await ctx.db.patch("agentTasks", task._id, { status, startedAt: now, updatedAt: now });
    }
    const { role, ownedPaths, brief, title, modelId, model, taskId, messageId, projectId } = task;
    return { role, ownedPaths, brief, title, modelId, model, taskId, messageId, projectId, status };
  },
});

export const finishTask = mutation({
  args: {
    internalKey: v.string(),
    agentTaskId: v.id("agentTasks"),
    status: v.union(v.literal("done"), v.literal("error")),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const task = await ctx.db.get("agentTasks", args.agentTaskId);
    if (!task || task.status === "done" || task.status === "error") return null;
    const now = Date.now();
    await ctx.db.patch("agentTasks", task._id, {
      status: args.status,
      summary: args.summary,
      error: args.error,
      startedAt: task.startedAt ?? now,
      endedAt: now,
      updatedAt: now,
    });
    // A failed sub-orchestrator's workers can't report to anyone.
    if (args.status === "error" && task.role === "sub-orchestrator") {
      const children = await ctx.db.query("agentTasks")
        .withIndex("by_message", (q) => q.eq("messageId", task.messageId))
        .take(MAX_SWARM_AGENTS);
      for (const child of children) {
        if (child.parentTaskId !== task.taskId || child.status === "done" || child.status === "error") continue;
        await ctx.db.patch("agentTasks", child._id, {
          status: "error", error: "Parent sub-orchestrator failed.", startedAt: child.startedAt ?? now, endedAt: now, updatedAt: now,
        });
      }
    }
    return null;
  },
});

export const listForMessage = query({
  args: { messageId: v.id("messages") },
  returns: v.array(schema.tables.agentTasks.validator.extend({
    _id: v.id("agentTasks"),
    _creationTime: v.number(),
  })),
  handler: async (ctx, { messageId }) => {
    const identity = await verifyAuth(ctx);
    const message = await ctx.db.get("messages", messageId);
    // A message deleted mid-view has no tasks left to show; its rows went with it.
    if (!message) return [];
    await getOwnedProject(ctx, message.projectId, identity.subject);
    return await ctx.db.query("agentTasks")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .order("asc")
      .take(MAX_SWARM_AGENTS);
  },
});
