import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { copyCheckpointFiles, createCheckpoint, deleteCheckpoint } from "./checkpoints";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { deleteProjectBatch } from "./projectCascade";
import { assertCanCopy, copyProjectFiles, remixProject } from "./projectCopy";
import { userSkillKey } from "../src/features/skills/types";
import { MAX_PROJECT_SKILLS } from "../src/features/skills/limits";
import {
  copyProjectName,
  validateProjectName,
} from "../src/features/projects/utils/project-name";
import { MAX_PROJECT_INSTRUCTIONS_LENGTH } from "../src/features/projects/instructions";
import { validateTheme } from "../src/features/projects/theme";
import { projectThemeValidator } from "./schema";
import { countProjectBuilt } from "./stats";
import { recordProjectEvent } from "./activationEvents";
import { lastRunStatuses } from "../src/features/projects/utils/project-status";

/** Env vars and skill settings copied per duplicate; far above real usage. */
const MAX_COPIED_ROWS = 500;

/** Most projects listed for one owner (#53). */
const MAX_PROJECTS_LISTED = 500;

/** Most projects `getPartial` returns, whatever the client asks for (#212). */
const MAX_PARTIAL_PROJECTS = 50;
/** Newest run events read per user for card status (#318); runs older than these get none. */
const MAX_RUN_EVENTS = 200;

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

/** Sets the project's always-on agent instructions; empty text clears them (#299). */
export const updateInstructions = mutation({
  args: {
    id: v.id("projects"),
    instructions: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.id, identity.subject);

    const instructions = args.instructions.trim();
    if (instructions.length > MAX_PROJECT_INSTRUCTIONS_LENGTH) {
      throw appError(
        "INVALID_ARGUMENT",
        `Instructions must be at most ${MAX_PROJECT_INSTRUCTIONS_LENGTH} characters`,
      );
    }

    await ctx.db.patch("projects", args.id, {
      instructions: instructions || undefined,
      updatedAt: Date.now(),
    });
  },
});

/** Sets the project's brand theme; no theme clears it (#302). */
export const updateTheme = mutation({
  args: {
    id: v.id("projects"),
    theme: v.optional(projectThemeValidator),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await getOwnedProject(ctx, args.id, identity.subject);

    const theme = args.theme && {
      ...args.theme,
      primary: args.theme.primary.toLowerCase(),
      accent: args.theme.accent.toLowerCase(),
    };
    const error = theme && validateTheme(theme);
    if (error) throw appError("INVALID_ARGUMENT", error);

    await ctx.db.patch("projects", args.id, { theme, updatedAt: Date.now() });
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

/**
 * The user's projects, each with optional `published` and `lastRun` for its
 * dashboard card (#318). Both come from a fixed number of reads per user, not
 * per project.
 */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    const userId = identity.subject;

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .order("desc")
      .filter((q) => q.eq(q.field("deletingAt"), undefined))
      .take(MAX_PROJECTS_LISTED);

    // shortcut: reads whole showcase rows, so a view of a published project
    // re-runs its owner's list; add a by_owner_and_status index if that shows up.
    const showcase = await ctx.db
      .query("showcaseProjects")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(MAX_PROJECTS_LISTED);
    const published = new Set<string>(
      showcase.filter((entry) => entry.status === "published").map((entry) => entry.projectId),
    );

    const runEvents = (name: "run_started" | "run_finished") =>
      ctx.db
        .query("activationEvents")
        .withIndex("by_userId_and_name_and_at", (q) => q.eq("userId", userId).eq("name", name))
        .order("desc")
        .take(MAX_RUN_EVENTS);
    const started = await runEvents("run_started");
    const finished = (await runEvents("run_finished")).flatMap((event) =>
      event.name === "run_finished"
        ? [{ projectId: event.projectId, at: event.at, outcome: event.props.outcome }]
        : [],
    );
    const lastRun = lastRunStatuses(started, finished);

    // Unset rather than false/absent values, so older clients see the same docs.
    return projects.map((project) => ({
      ...project,
      published: published.has(project._id) || undefined,
      lastRun: lastRun.get(project._id),
    }));
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
      // A chosen name is never replaced by a generated title (#288).
      nameSource: undefined,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Copies a project into a new one named "<name> (copy)": files, settings,
 * instructions, theme, project skills with their enabled states, and public env vars. Secret env
 * vars, conversations and integrations stay with the original.
 */
export const duplicate = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const source = await getOwnedProject(ctx, args.id, identity.subject);
    await assertCanCopy(ctx, identity.subject);

    const newProjectId = await ctx.db.insert("projects", {
      name: copyProjectName(source.name),
      ownerId: source.ownerId,
      settings: source.settings,
      instructions: source.instructions,
      theme: source.theme,
      updatedAt: Date.now(),
    });
    await countProjectBuilt(ctx);
    await recordProjectEvent(ctx, newProjectId, {
      name: "project_created",
      props: { source: "duplicate" },
    });

    // The owner's own copy: secret files stay, like their other files.
    await copyProjectFiles(ctx, source._id, newProjectId, { keepSecretFiles: true });

    await copyProjectConfiguration(ctx, source._id, newProjectId);

    return newProjectId;
  },
});

/** Shared project skills, enabled states and public env vars for owner copies. */
async function copyProjectConfiguration(
  ctx: MutationCtx,
  sourceId: Id<"projects">,
  newProjectId: Id<"projects">,
) {
  // Project skills get new ids, so their settings keys are remapped.
  const skillKeyMap = new Map<string, string>();
  const skills = await ctx.db
    .query("skills")
    .withIndex("by_project", (q) => q.eq("projectId", sourceId))
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
    .withIndex("by_project", (q) => q.eq("projectId", sourceId))
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
    .withIndex("by_project", (q) => q.eq("projectId", sourceId))
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
}

/** Branch from saved files without changing the source, even during a run. */
export const forkFromCheckpoint = mutation({
  args: { checkpointId: v.id("checkpoints") },
  returns: v.id("projects"),
  handler: async (ctx, { checkpointId }) => {
    const identity = await verifyAuth(ctx);
    const checkpoint = await ctx.db.get("checkpoints", checkpointId);
    if (!checkpoint) throw appError("NOT_FOUND", "Checkpoint not found");
    const source = await getOwnedProject(ctx, checkpoint.projectId, identity.subject);
    await assertCanCopy(ctx, identity.subject);
    const newProjectId = await ctx.db.insert("projects", {
      name: copyProjectName(source.name, " (fork)"),
      ownerId: source.ownerId,
      settings: source.settings,
      instructions: source.instructions,
      theme: source.theme,
      updatedAt: Date.now(),
    });
    await countProjectBuilt(ctx);
    await copyCheckpointFiles(ctx, checkpointId, newProjectId);
    await copyProjectConfiguration(ctx, source._id, newProjectId);
    return newProjectId;
  },
});

/** A share token: 128 random bits as hex (#260). */
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The project a share token opens, unless the link was revoked or the project is being deleted. */
export async function getSharedProject(ctx: QueryCtx, token: string) {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const project = await ctx.db
    .query("projects")
    .withIndex("by_shareToken", (q) => q.eq("shareToken", token))
    .first();
  return project && project.deletingAt === undefined ? project : null;
}

/**
 * Turns on the project's read-only share link and returns its token; an
 * existing link is kept. An action, because mutations run on seeded (replayable)
 * randomness and a token must be unpredictable.
 */
export const createShareLink = action({
  args: { projectId: v.id("projects") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const identity = await verifyAuth(ctx);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return await ctx.runMutation(internal.projects.setShareToken, {
      projectId: args.projectId,
      ownerId: identity.subject,
      token,
    });
  },
});

/** Stores `token` on the owner's project unless it already has one; returns the token in use. */
export const setShareToken = internalMutation({
  args: { projectId: v.id("projects"), ownerId: v.string(), token: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const project = await getOwnedProject(ctx, args.projectId, args.ownerId);
    if (project.shareToken) return project.shareToken;
    await ctx.db.patch("projects", project._id, { shareToken: args.token });
    return args.token;
  },
});

/** Turns the share link off: the old URL stops working, and a new link gets a new token. */
export const revokeShareLink = mutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);
    await ctx.db.patch("projects", args.projectId, { shareToken: undefined, shareCheckpointId: undefined, shareKeepLiveUntil: undefined });
    const checkpoint = project.shareCheckpointId && await ctx.db.get("checkpoints", project.shareCheckpointId);
    if (checkpoint) await deleteCheckpoint(ctx, checkpoint);
    return null;
  },
});

/** Public metadata only. The former file endpoints deliberately disclose no code. */
export const getShared = query({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({ name: v.string() })),
  handler: async (ctx, { token }) => {
    const project = await getSharedProject(ctx, token);
    return project ? { name: project.name } : null;
  },
});

/** Retired, including for callers that still know a file id. */
export const getSharedFile = query({
  args: { token: v.string(), fileId: v.id("files") },
  returns: v.null(),
  handler: async () => null,
});

export const configureShare = mutation({
  args: { projectId: v.id("projects"), mode: v.union(v.literal("snapshot"), v.literal("latest")),
    minutes: v.union(v.literal(0), v.literal(15), v.literal(30), v.literal(60)),
    updateSnapshot: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);
    const checkpointId = args.mode === "snapshot" &&
      (args.updateSnapshot || !project.shareCheckpointId || project.shareMode !== "snapshot")
      ? await createCheckpoint(ctx, { projectId: project._id, label: "Shared version" })
      : project.shareCheckpointId;
    await ctx.db.patch("projects", project._id, {
      shareMode: args.mode, shareKeepLiveMinutes: args.minutes, shareCheckpointId: args.mode === "snapshot" ? checkpointId : undefined,
      shareKeepLiveUntil: args.minutes ? Date.now() + args.minutes * 60_000 : undefined,
    });
    if (project.shareCheckpointId && (args.mode === "latest" || checkpointId !== project.shareCheckpointId)) {
      const old = await ctx.db.get("checkpoints", project.shareCheckpointId);
      if (old) await deleteCheckpoint(ctx, old);
    }
    return null;
  },
});

/** Remix from a share link: copies the shared files into a new project of the signed-in user. */
export const remixShared = mutation({
  args: { token: v.string() },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getSharedProject(ctx, args.token);
    if (!project) throw appError("NOT_FOUND", "Project not found");
    if (project.shareMode !== "snapshot" || !project.shareCheckpointId) {
      return await remixProject(ctx, project._id, identity.subject, `${project.name} (imported)`);
    }
    await assertCanCopy(ctx, identity.subject);
    const id = await ctx.db.insert("projects", { name: `${project.name} (imported)`, ownerId: identity.subject, updatedAt: Date.now() });
    await countProjectBuilt(ctx);
    await copyCheckpointFiles(ctx, project.shareCheckpointId, id, false);
    return id;
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
    const project = await ctx.db.get("projects", args.id);
    if (!project) return;

    if (!(await deleteProjectBatch(ctx, args.id))) {
      await ctx.scheduler.runAfter(Math.max(0, (project.publicPreview?.until ?? 0) - Date.now()), internal.projects.deleteBatch, {
        id: args.id,
      });
    }
  },
});
/**
 * Whether a conversation's project still needs its first build: seeded and not
 * yet built (#338), or with no files at all. Auto routing (#322) sends it to the
 * build model. The caller checks ownership; the answer only picks a model.
 */
export const conversationNeedsFirstBuildForServer = query({
  args: { internalKey: v.string(), conversationId: v.id("conversations") },
  returns: v.boolean(),
  handler: async (ctx, { internalKey, conversationId }) => {
    validateInternalKey(internalKey);
    const conversation = await ctx.db.get("conversations", conversationId);
    const project = conversation && (await ctx.db.get("projects", conversation.projectId));
    if (!project) return true;
    if (project.firstBuildPending === true) return true;
    const file = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .first();
    return file === null;
  },
});

/**
 * Ends a seeded project's first build (#338): called by the agent run that
 * wrote files and finished. Failed, cancelled, plan and Q&A runs leave it set.
 * True when this call ended it, so that run gets the ship card (#341).
 */
export const completeFirstBuild = mutation({
  args: { internalKey: v.string(), projectId: v.id("projects") },
  returns: v.boolean(),
  handler: async (ctx, { internalKey, projectId }) => {
    validateInternalKey(internalKey);
    const project = await ctx.db.get("projects", projectId);
    if (!project?.firstBuildPending) return false;
    await ctx.db.patch("projects", projectId, { firstBuildPending: undefined });
    return true;
  },
});
