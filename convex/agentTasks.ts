import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { mergeMessageSteps } from "./messageSteps";
import { getOwnedProject } from "./projects";
import schema, { agentTaskInputValidator, agentTaskStatusValidator, messageStepValidator } from "./schema";
import { MAX_SWARM_TASKS } from "./swarm";

/** Replays return the original rows without resetting their instructions or state. */
export const createTasks = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    projectId: v.id("projects"),
    tasks: v.array(agentTaskInputValidator),
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
    const existing = await ctx.db.query("agentTasks")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .take(MAX_SWARM_TASKS + 1);
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
      if (count >= MAX_SWARM_TASKS) {
        throw appError("LIMIT_EXCEEDED", "Too many swarm tasks");
      }
      ids.push(await ctx.db.insert("agentTasks", {
        ...task,
        messageId: args.messageId,
        projectId: args.projectId,
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
  returns: agentTaskInputValidator.omit("role").extend({
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
    const { ownedPaths, brief, title, modelId, model, taskId, messageId, projectId } = task;
    return { ownedPaths, brief, title, modelId, model, taskId, messageId, projectId, status };
  },
});

export const finishTask = mutation({
  args: {
    internalKey: v.string(),
    agentTaskId: v.id("agentTasks"),
    status: v.union(v.literal("done"), v.literal("error")),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    selfCheck: v.optional(v.string()),
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
      ...(args.selfCheck !== undefined ? { selfCheck: args.selfCheck } : {}),
      startedAt: task.startedAt ?? now,
      endedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/** Stores the swarm's foundation snapshot on its task rows, for the workers' self-checks. */
export const setSeedSnapshot = mutation({
  args: { internalKey: v.string(), messageId: v.id("messages"), snapshotId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const tasks = await ctx.db.query("agentTasks")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .take(MAX_SWARM_TASKS);
    for (const task of tasks) await ctx.db.patch("agentTasks", task._id, { seedSnapshotId: args.snapshotId });
    return null;
  },
});

/**
 * Takes one of the swarm's `max` self-check slots for this task. A slot is any
 * sibling's self-check that was not skipped. Retries keep a slot already taken.
 */
export const claimSelfCheck = mutation({
  args: { internalKey: v.string(), agentTaskId: v.id("agentTasks"), max: v.number() },
  returns: v.union(v.object({ seedSnapshotId: v.string() }), v.object({ skipped: v.string() })),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const task = await ctx.db.get("agentTasks", args.agentTaskId);
    if (!task || task.status === "done" || task.status === "error") return { skipped: "task finished" };
    const { seedSnapshotId } = task;
    if (!seedSnapshotId) return { skipped: "no snapshot yet" };
    if (task.selfCheck === "running") return { seedSnapshotId };
    const siblings = await ctx.db.query("agentTasks")
      .withIndex("by_message", (q) => q.eq("messageId", task.messageId))
      .take(MAX_SWARM_TASKS);
    const taken = siblings.filter((row) => row.selfCheck !== undefined && !row.selfCheck.startsWith("skipped")).length;
    if (taken >= args.max) return { skipped: "swarm sandbox cap reached" };
    await ctx.db.patch("agentTasks", task._id, { selfCheck: "running", updatedAt: Date.now() });
    return { seedSnapshotId };
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
    if (!message) throw appError("NOT_FOUND", "Message not found");
    await getOwnedProject(ctx, message.projectId, identity.subject);
    return await ctx.db.query("agentTasks")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .order("asc")
      .take(MAX_SWARM_TASKS);
  },
});
