import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { deleteProjectBatch } from "./projectCascade";
import { copyProjectFiles } from "./projectCopy";
import { userSkillKey } from "../src/features/skills/types";
import { MAX_PROJECT_SKILLS } from "../src/features/skills/limits";
import {
  copyProjectName,
  validateProjectName,
} from "../src/features/projects/utils/project-name";
import { countProjectBuilt } from "./stats";
import { recordProjectEvent } from "./activationEvents";

/** Env vars and skill settings copied per duplicate; far above real usage. */
const MAX_COPIED_ROWS = 500;

/** Most projects listed for one owner (#53). */
const MAX_PROJECTS_LISTED = 500;

/** Most projects `getPartial` returns, whatever the client asks for (#212). */
const MAX_PARTIAL_PROJECTS = 50;

/**
 * The caller's project. Projects being deleted count as gone, so they can't
 * be opened, renamed or copied while their data is removed.
 */
export async function getOwnedProject(
  ctx: QueryCtx | MutationCtx,
  id: Id<"projects">,
  ownerId: string,
) {
  const project = await ctx.db.get("projects", id);

  // Typed, so the project page can tell "gone" from other errors (#266).
  if (!project || project.deletingAt !== undefined) {
    throw appError("NOT_FOUND", "Project not found");
  }

  if (project.ownerId !== ownerId) {
    throw appError("FORBIDDEN", "Unauthorized access to this project");
  }

  return project;
}

function assertValidName(name: string) {
  const error = validateProjectName(name);
  if (error) {
    throw appError("INVALID_ARGUMENT", error);
  }
}

export const updateSettings = mutation({
  args: {
    id: v.id("projects"),
    settings: v.object({
      installCommand: v.optional(v.string()),
      devCommand: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.id, identity.subject);

    await ctx.db.patch("projects", args.id, {
      settings: args.settings,
      updatedAt: Date.now(),
    });
  },
});

export const create = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const projectId = await ctx.db.insert("projects", {
      name: args.name,
      ownerId: identity.subject,
      updatedAt: Date.now(),
    });
    await countProjectBuilt(ctx);
    await recordProjectEvent(ctx, projectId, {
      name: "project_created",
      props: { source: "dashboard" },
    });

    return projectId;
  },
});

export const getPartial = query({
  args: {
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    return await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .order("desc")
      .filter((q) => q.eq(q.field("deletingAt"), undefined))
      .take(Math.min(Math.max(Math.floor(args.limit), 1), MAX_PARTIAL_PROJECTS));
  },
});

export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);

    return await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .order("desc")
      .filter((q) => q.eq(q.field("deletingAt"), undefined))
      .take(MAX_PROJECTS_LISTED);
  },
});

export const getById = query({
  args: {
    id: v.id("projects")
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    return await getOwnedProject(ctx, args.id, identity.subject);
  },
});

export const rename = mutation({
  args: {
    id: v.id("projects"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.id, identity.subject);

    const name = args.name.trim();
    assertValidName(name);

    await ctx.db.patch("projects", args.id, {
      name,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Copies a project into a new one named "<name> (copy)": files, settings,
 * project skills with their enabled states, and public env vars. Secret env
 * vars, conversations and integrations stay with the original.
 */
export const duplicate = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const source = await getOwnedProject(ctx, args.id, identity.subject);

    const newProjectId = await ctx.db.insert("projects", {
      name: copyProjectName(source.name),
      ownerId: source.ownerId,
      settings: source.settings,
      updatedAt: Date.now(),
    });
    await countProjectBuilt(ctx);
    await recordProjectEvent(ctx, newProjectId, {
      name: "project_created",
      props: { source: "duplicate" },
    });

    await copyProjectFiles(ctx, source._id, newProjectId);

    // Project skills get new ids, so their settings keys are remapped.
    const skillKeyMap = new Map<string, string>();
    const skills = await ctx.db
      .query("skills")
      .withIndex("by_project", (q) => q.eq("projectId", source._id))
      .take(MAX_PROJECT_SKILLS);
    for (const skill of skills) {
      const newSkillId = await ctx.db.insert("skills", {
        ownerId: skill.ownerId,
        projectId: newProjectId,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        source: skill.source,
        sourceUrl: skill.sourceUrl,
        updatedAt: Date.now(),
      });
      skillKeyMap.set(userSkillKey(skill._id), userSkillKey(newSkillId));
    }

    const settings = await ctx.db
      .query("projectSkillSettings")
      .withIndex("by_project", (q) => q.eq("projectId", source._id))
      .take(MAX_COPIED_ROWS);
    for (const setting of settings) {
      await ctx.db.insert("projectSkillSettings", {
        projectId: newProjectId,
        ownerId: setting.ownerId,
        skillKey: skillKeyMap.get(setting.skillKey) ?? setting.skillKey,
        enabled: setting.enabled,
        updatedAt: Date.now(),
      });
    }

    const envVars = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project", (q) => q.eq("projectId", source._id))
      .take(MAX_COPIED_ROWS);
    for (const envVar of envVars) {
      if (envVar.visibility !== "public") continue;
      await ctx.db.insert("projectEnvVars", {
        projectId: newProjectId,
        ownerId: envVar.ownerId,
        key: envVar.key,
        visibility: "public",
        plainValue: envVar.plainValue,
        maskedPreview: envVar.maskedPreview,
        source: envVar.source,
        sourceConnectionId: envVar.sourceConnectionId,
        updatedAt: Date.now(),
      });
    }

    return newProjectId;
  },
});

/**
 * Deletes a project and everything in it. The project disappears at once
 * (`deletingAt`); its data is removed in batches by `deleteBatch`.
 */
export const remove = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.id, identity.subject);

    await ctx.db.patch("projects", args.id, { deletingAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.projects.deleteBatch, {
      id: args.id,
    });
  },
});

/** One bounded batch of a project deletion; reschedules itself until done. */
export const deleteBatch = internalMutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get("projects", args.id))) return;

    if (!(await deleteProjectBatch(ctx, args.id))) {
      await ctx.scheduler.runAfter(0, internal.projects.deleteBatch, {
        id: args.id,
      });
    }
  },
});