import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { validateInternalKey } from "./internalKey";
import { assertCanRunForUser, chargeRunForUser, readAccountView } from "./credits";
import {
  aiProviderValidator,
  messageStepValidator,
  runModelValidator,
} from "./schema";
import { createCheckpoint } from "./checkpoints";
import { appError } from "./errors";
import {
  CASCADE_BATCH_SIZE,
  deleteRows,
  getUnclaimedStorage,
  releaseBlobs,
} from "./projectCascade";
import { assertOwnedImages, withImageUrls } from "./chatImages";
import {
  MAX_PROJECT_FILES,
  assertProjectFolder,
  deleteFileTree,
  findSibling,
  getProjectFile,
} from "./files";
import { resolveProjectSkills } from "./skills";
import { countProjectBuilt } from "./stats";
import { MAX_ENV_VARS } from "./envVars";
import { MAX_PROJECT_CONNECTIONS } from "./integrations";

// Keeps the steps array (and the message document) bounded on long runs.
const MAX_MESSAGE_STEPS = 100;

/** Most messages `getRecentMessages` returns as agent context (#53). */
const MAX_RECENT_MESSAGES = 50;

/** A project runs one agent at a time; lost runs are failed by a cron. */
const MAX_PROCESSING_MESSAGES = 20;

export const getConversationById = query({
  args: {
    conversationId: v.id("conversations"),
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.get("conversations", args.conversationId);
  },
});

export const createMessage = mutation({
  args: {
    internalKey: v.string(),
    conversationId: v.id("conversations"),
    projectId: v.id("projects"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    status: v.optional(
      v.union(
        v.literal("processing"),
        v.literal("completed"),
        v.literal("cancelled")
      )
    ),
    runModel: v.optional(runModelValidator),
    images: v.optional(v.array(v.id("_storage"))),
    // The sender, required with images: only their own uploads can be attached.
    ownerId: v.optional(v.string()),
    mode: v.optional(v.literal("plan")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const conversation = await ctx.db.get("conversations", args.conversationId);
    if (!conversation || conversation.projectId !== args.projectId) {
      throw new Error("Conversation not found");
    }

    if (args.images?.length) {
      await assertOwnedImages(ctx, args.images, {
        projectId: args.projectId,
        ownerId: args.ownerId,
      });
    }

    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      status: args.status,
      runModel: args.runModel,
      ...(args.images?.length ? { images: args.images } : {}),
      ...(args.mode ? { mode: args.mode } : {}),
    });

    // Update conversation's updatedAt
    await ctx.db.patch("conversations", args.conversationId, {
      updatedAt: Date.now(),
    });

    return messageId;
  },
});

export const updateMessageContent = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("messages", args.messageId, {
      content: args.content,
      status: "completed" as const,
      completedAt: Date.now(),
    });
  },
});

// Records agent activity for display. Upserts by step id so replays are no-ops.
export const upsertMessageSteps = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    steps: v.array(messageStepValidator),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const message = await ctx.db.get("messages", args.messageId);
    if (!message) {
      return;
    }

    const steps = [...(message.steps ?? [])];
    for (const incoming of args.steps) {
      const index = steps.findIndex((step) => step.id === incoming.id);
      if (index === -1) {
        steps.push(incoming);
      } else {
        // Fields the update leaves out (e.g. targets) keep their recorded value.
        steps[index] = {
          ...steps[index],
          ...incoming,
          startedAt: steps[index].startedAt,
        };
      }
    }

    await ctx.db.patch("messages", args.messageId, {
      steps: steps.slice(-MAX_MESSAGE_STEPS),
    });
  },
});

export const updateMessageStatus = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("cancelled")
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("messages", args.messageId, {
      status: args.status,
      completedAt: args.status === "processing" ? undefined : Date.now(),
    });
  },
});

export const getMessageById = query({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.get("messages", args.messageId);
  },
});

export const getProcessingMessages = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("messages")
      .withIndex("by_project_status", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("status", "processing")
      )
      .take(MAX_PROCESSING_MESSAGES);
  },
});

// Used for Agent conversation context
export const getRecentMessages = query({
  args: {
    internalKey: v.string(),
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? 10), 1),
      MAX_RECENT_MESSAGES
    );
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .take(limit);

    return await withImageUrls(ctx, messages.reverse());
  },
});

// Used for Agent to update conversation title
export const updateConversationTitle = mutation({
  args: {
    internalKey: v.string(),
    conversationId: v.id("conversations"),
    title: v.string(),
  },
   handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("conversations", args.conversationId, {
      title: args.title,
      updatedAt: Date.now(),
    });
   },
});

// Used for Agent "ListFiles" tool
export const getProjectFiles = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_PROJECT_FILES);
  },
});

// Snapshot of the project's files taken before an agent run (#43).
export const createProjectCheckpoint = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    messageId: v.id("messages"),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const message = await ctx.db.get("messages", args.messageId);
    if (!message || message.projectId !== args.projectId) {
      throw new Error("Message not found");
    }

    return await createCheckpoint(ctx, {
      projectId: args.projectId,
      messageId: args.messageId,
      label: args.label,
    });
  },
});

// Used for Agent "ReadFiles" tool
export const getFileById = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    // The agent supplies this id, so a malformed one is a missing file, not
    // an ArgumentValidationError the caller would have to match by name.
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const fileId = ctx.db.normalizeId("files", args.fileId);
    if (!fileId) return null;

    return await getProjectFile(ctx, args.projectId, fileId);
  },
});

// Used for Agent "UpdateFile" tool
export const updateFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    fileId: v.id("files"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await getProjectFile(ctx, args.projectId, args.fileId);

    if (!file) {
      throw new Error("File not found");
    }

    await ctx.db.patch("files", args.fileId, {
      content: args.content,
      updatedAt: Date.now(),
    });

    return args.fileId;
  },
});

// Used for Agent "CreateFile" tool
export const createFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    content: v.string(),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await assertProjectFolder(ctx, args.projectId, args.parentId);

    if (await findSibling(ctx, { ...args, type: "file" })) {
      throw new Error("File already exists");
    }

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      content: args.content,
      type: "file",
      parentId: args.parentId,
      updatedAt: Date.now(),
    });

    return fileId;
  },
});

// Used for Agent bulk "CreateFiles" tool
export const createFiles = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
    files: v.array(
      v.object({
        name: v.string(),
        content: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await assertProjectFolder(ctx, args.projectId, args.parentId);

    const results: { name: string; fileId: string; error?: string }[] = [];

    for (const file of args.files) {
      const existing = await findSibling(ctx, {
        projectId: args.projectId,
        parentId: args.parentId,
        name: file.name,
        type: "file",
      });

      if (existing) {
        results.push({
          name: file.name,
          fileId: existing._id,
          error: "File already exists",
        });
        continue;
      }

      const fileId = await ctx.db.insert("files", {
        projectId: args.projectId,
        name: file.name,
        content: file.content,
        type: "file",
        parentId: args.parentId,
        updatedAt: Date.now(),
      });

      results.push({ name: file.name, fileId });
    }

    return results;
  },
});

// Used for Agent "CreateFolder" tool
export const createFolder = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await assertProjectFolder(ctx, args.projectId, args.parentId);

    if (await findSibling(ctx, { ...args, type: "folder" })) {
      throw new Error("Folder already exists");
    }

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      type: "folder",
      parentId: args.parentId,
      updatedAt: Date.now(),
    });

    return fileId;
  },
});

// Used for Agent "RenameFile" tool
export const renameFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    fileId: v.id("files"),
    newName: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await getProjectFile(ctx, args.projectId, args.fileId);
    if (!file) {
      throw new Error("File not found");
    }

    // Check if a file with the new name already exists in the same parent folder
    if (await findSibling(ctx, { ...file, name: args.newName }, args.fileId)) {
      throw new Error(`A ${file.type} named "${args.newName}" already exists`);
    }

    await ctx.db.patch("files", args.fileId, {
      name: args.newName,
      updatedAt: Date.now(),
    });

    return args.fileId;
  },
});

// Used for Agent "DeleteFile" tool
export const deleteFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await getProjectFile(ctx, args.projectId, args.fileId);
    if (!file) {
      throw new Error("File not found");
    }

    await deleteFileTree(ctx, file);

    return args.fileId;
  },
});

/**
 * Deletes one batch of the project's files. Callers repeat it until `done`, so
 * a project of any size stays inside one transaction's limits (#212).
 */
export const cleanup = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(CASCADE_BATCH_SIZE);

    await deleteRows(ctx, "files", files);
    await releaseBlobs(ctx, files.map((file) => file.storageId));

    return { deleted: files.length, done: files.length < CASCADE_BATCH_SIZE };
  },
});

export const generateUploadUrl = mutation({
  args: {
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await ctx.storage.generateUploadUrl();
  },
});

export const createBinaryFile = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    storageId: v.id("_storage"),
    parentId: v.optional(v.id("files")),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await assertProjectFolder(ctx, args.projectId, args.parentId);
    await getUnclaimedStorage(ctx, args.storageId);

    if (await findSibling(ctx, { ...args, type: "file" })) {
      throw new Error("File already exists");
    }

    const fileId = await ctx.db.insert("files", {
      projectId: args.projectId,
      name: args.name,
      type: "file",
      storageId: args.storageId,
      parentId: args.parentId,
      updatedAt: Date.now(),
    });
    
    return fileId;
  },
});

export const updateImportStatus = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    status: v.optional(
      v.union(
        v.literal("importing"),
        v.literal("completed"),
        v.literal("failed")
      )
    ),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("projects", args.projectId, {
      importStatus: args.status,
      updatedAt: Date.now(),
    });
  },
});

export const updateExportStatus = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    status: v.optional(
      v.union(
        v.literal("exporting"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled")
      )
    ),
    repoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("projects", args.projectId, {
      exportStatus: args.status,
      exportRepoUrl: args.repoUrl,
      updatedAt: Date.now(),
    });
  },
});

export const getProjectFilesWithUrls = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_PROJECT_FILES);

    return await Promise.all(
      files.map(async (file) => {
        if (file.storageId) {
          const url = await ctx.storage.getUrl(file.storageId);
          return { ...file, storageUrl: url };
        }
        return { ...file, storageUrl: null };
      })
    );
  },
});

export const createProject = mutation({
  args: {
    internalKey: v.string(),
    name: v.string(),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const projectId = await ctx.db.insert("projects", {
      name: args.name,
      ownerId: args.ownerId,
      updatedAt: Date.now(),
      importStatus: "importing",
    });
    await countProjectBuilt(ctx);

    return projectId;
  },
});

export const createProjectWithConversation = mutation({
  args: {
    internalKey: v.string(),
    projectName: v.string(),
    conversationTitle: v.string(),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const now = Date.now();

    const projectId = await ctx.db.insert("projects", {
      name: args.projectName,
      ownerId: args.ownerId,
      updatedAt: now,
    });
    await countProjectBuilt(ctx);

    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: args.conversationTitle,
      updatedAt: now,
    });

    return { projectId, conversationId };
  },
});


// ─────────────────────────────────────────────────────────────────────────────
// Integrations
//
// These are called from Next.js route handlers and Inngest steps, which hold the
// KEK and can seal/unseal credentials. Convex only ever stores and returns the
// sealed form.
//
// ## Why owner scoping still matters behind internalKey
//
// `internalKey` authenticates "this is our own server", not "this request is on
// behalf of user X". Without an explicit owner check, a bug that passed the wrong
// projectId would hand one tenant's credentials to another tenant's agent run.
// `getProjectMcpConnections` therefore refuses any link whose credential owner
// differs from the project owner, so internalKey is not a master key over every
// user's tokens.
// ─────────────────────────────────────────────────────────────────────────────

const sealedFields = {
  kekProvider: v.string(),
  kekKeyId: v.string(),
  wrappedDek: v.string(),
  ciphertext: v.string(),
  iv: v.string(),
  authTag: v.string(),
} as const;

export const createUserConnection = mutation({
  args: {
    internalKey: v.string(),
    userId: v.string(),
    projectId: v.optional(v.id("projects")),
    providerId: v.string(),
    label: v.string(),
    authMode: v.union(v.literal("oauth"), v.literal("api_key")),
    serverUrl: v.string(),
    credentialRef: v.string(),
    maskedPreview: v.string(),
    scopes: v.array(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    oauthClientId: v.optional(v.string()),
    authServerUrl: v.optional(v.string()),
    ...sealedFields,
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    if (args.projectId) {
      const project = await ctx.db.get("projects", args.projectId);
      if (!project || project.ownerId !== args.userId) {
        throw appError("NOT_FOUND", "Project not found or owned by another user");
      }
    }

    const now = Date.now();

    const connectionId = await ctx.db.insert("userConnections", {
      userId: args.userId,
      providerId: args.providerId,
      label: args.label,
      authMode: args.authMode,
      serverUrl: args.serverUrl,
      status: "active" as const,
      credentialRef: args.credentialRef,
      kekProvider: args.kekProvider,
      kekKeyId: args.kekKeyId,
      wrappedDek: args.wrappedDek,
      ciphertext: args.ciphertext,
      iv: args.iv,
      authTag: args.authTag,
      maskedPreview: args.maskedPreview,
      scopes: args.scopes,
      tokenExpiresAt: args.tokenExpiresAt,
      oauthClientId: args.oauthClientId,
      authServerUrl: args.authServerUrl,
      createdAt: now,
      updatedAt: now,
    });

    if (!args.projectId) return { connectionId };

    const projectConnectionId = await ctx.db.insert("projectConnections", {
      projectId: args.projectId,
      userConnectionId: connectionId,
      ownerId: args.userId,
      enabled: true,
      readOnly: true,
      providerScope: {},
      writeApproved: false,
      createdAt: now,
      updatedAt: now,
    });

    return { connectionId, projectConnectionId };
  },
});

/**
 * The connection when it belongs to `projectId`'s owner, else `null`. Agent runs
 * act for a project, so they may only touch that owner's credentials (#239).
 */
const projectOwnerConnectionOrNull = async (
  ctx: QueryCtx,
  projectId: Id<"projects">,
  connectionId: Id<"userConnections">,
) => {
  const project = await ctx.db.get("projects", projectId);
  const connection = await ctx.db.get("userConnections", connectionId);
  return project && connection?.userId === project.ownerId ? connection : null;
};

export const updateUserConnectionStatus = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    connectionId: v.id("userConnections"),
    status: v.union(
      v.literal("active"),
      v.literal("needs_reauth"),
      v.literal("revoked"),
      v.literal("error"),
    ),
    statusMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    if (!(await projectOwnerConnectionOrNull(ctx, args.projectId, args.connectionId))) {
      throw appError("NOT_FOUND", "Connection not found");
    }

    await ctx.db.patch("userConnections", args.connectionId, {
      status: args.status,
      statusMessage: args.statusMessage,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Claim the right to refresh one OAuth credential.
 *
 * Refresh tokens may rotate. Without a database-backed lease, two agent runs
 * can exchange the same token concurrently and the loser can invalidate an
 * otherwise healthy connection. Convex serializes this mutation, so exactly one
 * caller receives the lease.
 */
export const claimUserConnectionRefresh = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    connectionId: v.id("userConnections"),
    leaseId: v.string(),
    refreshSkewMs: v.number(),
    leaseDurationMs: v.number(),
  },
  returns: v.union(
    v.literal("acquired"),
    v.literal("busy"),
    v.literal("not_needed"),
    v.literal("missing"),
  ),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const connection = await projectOwnerConnectionOrNull(
      ctx,
      args.projectId,
      args.connectionId,
    );
    if (!connection) return "missing" as const;

    const now = Date.now();
    const needsRefresh =
      connection.authMode === "oauth" &&
      typeof connection.tokenExpiresAt === "number" &&
      connection.tokenExpiresAt - args.refreshSkewMs <= now;

    if (!needsRefresh) return "not_needed" as const;

    if (
      connection.refreshLeaseId &&
      connection.refreshLeaseExpiresAt &&
      connection.refreshLeaseExpiresAt > now
    ) {
      return "busy" as const;
    }

    await ctx.db.patch("userConnections", args.connectionId, {
      refreshLeaseId: args.leaseId,
      refreshLeaseExpiresAt: now + args.leaseDurationMs,
    });

    return "acquired" as const;
  },
});

/** Commit a refreshed sealed OAuth bundle only when the caller owns the lease. */
export const completeUserConnectionRefresh = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    connectionId: v.id("userConnections"),
    leaseId: v.string(),
    maskedPreview: v.string(),
    scopes: v.array(v.string()),
    tokenExpiresAt: v.union(v.number(), v.null()),
    ...sealedFields,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const connection = await projectOwnerConnectionOrNull(
      ctx,
      args.projectId,
      args.connectionId,
    );
    if (!connection || connection.refreshLeaseId !== args.leaseId) return false;

    await ctx.db.patch("userConnections", args.connectionId, {
      kekProvider: args.kekProvider,
      kekKeyId: args.kekKeyId,
      wrappedDek: args.wrappedDek,
      ciphertext: args.ciphertext,
      iv: args.iv,
      authTag: args.authTag,
      maskedPreview: args.maskedPreview,
      scopes: args.scopes,
      tokenExpiresAt: args.tokenExpiresAt ?? undefined,
      status: "active" as const,
      statusMessage: undefined,
      refreshLeaseId: undefined,
      refreshLeaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });

    return true;
  },
});

/** Release a refresh lease and expose only a non-sensitive connection state. */
export const failUserConnectionRefresh = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    connectionId: v.id("userConnections"),
    leaseId: v.string(),
    reauthRequired: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const connection = await projectOwnerConnectionOrNull(
      ctx,
      args.projectId,
      args.connectionId,
    );
    if (!connection || connection.refreshLeaseId !== args.leaseId) return false;

    await ctx.db.patch("userConnections", args.connectionId, {
      status: args.reauthRequired ? "needs_reauth" : "active",
      statusMessage: args.reauthRequired
        ? "OAuth authorization expired. Reconnect this integration."
        : "OAuth refresh temporarily failed. It will be retried automatically.",
      refreshLeaseId: undefined,
      refreshLeaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });

    return true;
  },
});

/**
 * Every enabled MCP connection for a project, with sealed credentials attached.
 *
 * This is the agent's entry point for resolving which MCP servers a run may talk
 * to. Links whose credential belongs to someone other than the project owner are
 * skipped rather than returned — see the owner-scoping note above.
 */
export const getProjectMcpConnections = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const project = await ctx.db.get("projects", args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const links = await ctx.db
      .query("projectConnections")
      .withIndex("by_project_and_enabled", (q) =>
        q.eq("projectId", args.projectId).eq("enabled", true),
      )
      .take(MAX_PROJECT_CONNECTIONS);

    const resolved = [];

    for (const link of links) {
      const connection = await ctx.db.get(
        "userConnections",
        link.userConnectionId,
      );
      if (!connection) continue;

      // Cross-tenant guard. Reaching this branch means a bug elsewhere, so it is
      // worth the log line: silently skipping would hide the defect.
      if (connection.userId !== project.ownerId) {
        console.warn(
          `[system] skipping projectConnection ${link._id}: credential owner ` +
            `does not match project owner`,
        );
        continue;
      }

      // A revoked or expired-auth credential cannot produce a working session.
      // Skipping here means the agent simply lacks those tools, rather than
      // failing the whole run on one bad connection.
      if (connection.status !== "active") continue;

      resolved.push({ link, connection });
    }

    return resolved;
  },
});

/** Persist a discovered tool baseline for drift detection. */
export const setProjectConnectionToolBaseline = mutation({
  args: {
    internalKey: v.string(),
    projectConnectionId: v.id("projectConnections"),
    toolBaseline: v.array(v.object({ name: v.string(), digest: v.string() })),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("projectConnections", args.projectConnectionId, {
      toolBaseline: args.toolBaseline,
      toolBaselineAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// ─── Environment variables ───

/**
 * Every variable for a project, including sealed secret payloads.
 *
 * `internalKey` only. This is the counterpart to `envVars.listPublicEnvVars`:
 * the client-callable query cannot return secrets, and this one is never reachable
 * from a browser. Keeping them as separate functions is what makes the boundary
 * structural rather than a matter of passing the right flag.
 */
export const getEnvVarsForSandbox = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_ENV_VARS);
  },
});

/** Create or replace a sealed secret variable. */
export const setSecretEnvVar = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    ownerId: v.string(),
    key: v.string(),
    secretRef: v.string(),
    maskedPreview: v.string(),
    source: v.union(v.literal("manual"), v.literal("integration")),
    sourceConnectionId: v.optional(v.id("userConnections")),
    ...sealedFields,
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    // The row's ownerId decides who may delete it later (`envVars.deleteEnvVar`),
    // so it must be the project's real owner (#211).
    if (!(await ownedProjectOrNull(ctx, args.projectId, args.ownerId))) {
      throw appError("NOT_FOUND", "Project not found");
    }

    if (
      args.sourceConnectionId &&
      !(await projectOwnerConnectionOrNull(ctx, args.projectId, args.sourceConnectionId))
    ) {
      throw appError("NOT_FOUND", "Connection not found");
    }

    const existing = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", args.key),
      )
      .first();

    const now = Date.now();

    const sealed = {
      visibility: "secret" as const,
      secretRef: args.secretRef,
      kekProvider: args.kekProvider,
      kekKeyId: args.kekKeyId,
      wrappedDek: args.wrappedDek,
      ciphertext: args.ciphertext,
      iv: args.iv,
      authTag: args.authTag,
      maskedPreview: args.maskedPreview,
      source: args.source,
      sourceConnectionId: args.sourceConnectionId,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch("projectEnvVars", existing._id, {
        ...sealed,
        // Drop any plaintext left from when this key was public, so the row does
        // not carry two competing values.
        plainValue: undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("projectEnvVars", {
      projectId: args.projectId,
      ownerId: args.ownerId,
      key: args.key,
      ...sealed,
    });
  },
});

// ─── OAuth flow state ───

export const createOauthFlowState = mutation({
  args: {
    internalKey: v.string(),
    state: v.string(),
    userId: v.string(),
    projectId: v.optional(v.id("projects")),
    providerId: v.string(),
    serverUrl: v.string(),
    redirectUri: v.string(),
    oauthClientId: v.optional(v.string()),
    authServerUrl: v.string(),
    issuer: v.optional(v.string()),
    expiresAt: v.number(),
    ...sealedFields,
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    if (args.projectId) {
      const project = await ctx.db.get("projects", args.projectId);
      if (!project || project.ownerId !== args.userId) {
        throw appError("NOT_FOUND", "Project not found or owned by another user");
      }
    }

    return await ctx.db.insert("oauthFlowStates", {
      state: args.state,
      userId: args.userId,
      projectId: args.projectId,
      providerId: args.providerId,
      serverUrl: args.serverUrl,
      redirectUri: args.redirectUri,
      kekProvider: args.kekProvider,
      kekKeyId: args.kekKeyId,
      wrappedDek: args.wrappedDek,
      ciphertext: args.ciphertext,
      iv: args.iv,
      authTag: args.authTag,
      oauthClientId: args.oauthClientId,
      authServerUrl: args.authServerUrl,
      issuer: args.issuer,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
  },
});

export const getOauthFlowState = query({
  args: {
    internalKey: v.string(),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db
      .query("oauthFlowStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();
  },
});

/**
 * Delete a flow state, called immediately after a callback is consumed.
 *
 * Single-use is what prevents an intercepted authorization code from being
 * replayed against the same PKCE verifier.
 */
export const deleteOauthFlowState = mutation({
  args: {
    internalKey: v.string(),
    stateId: v.id("oauthFlowStates"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await ctx.db.delete("oauthFlowStates", args.stateId);
  },
});

// ─── Approvals & audit ───

export const createMcpApproval = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    messageId: v.optional(v.id("messages")),
    projectConnectionId: v.id("projectConnections"),
    providerId: v.string(),
    toolName: v.string(),
    argsPreview: v.string(),
    expiresAt: v.number(),
    mcpInvocationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    // The prompt goes to whoever owns the project, read here rather than taken
    // from the caller, and only for a link of that project (#239).
    const project = await ctx.db.get("projects", args.projectId);
    const link = await ctx.db.get("projectConnections", args.projectConnectionId);
    if (!project || link?.projectId !== args.projectId) {
      throw new Error("Project connection not found");
    }

    // Idempotent on the invocation id.
    //
    // The caller already creates this row inside a memoized workflow step, so a
    // second insert normally cannot happen. This covers the case that memoization
    // cannot: a request killed after the insert but before the step result was
    // checkpointed, which on retry would otherwise leave the user with a second
    // approval prompt for one action.
    if (args.mcpInvocationId) {
      const existing = await ctx.db
        .query("mcpApprovals")
        .withIndex("by_invocation", (q) =>
          q.eq("mcpInvocationId", args.mcpInvocationId),
        )
        .first();

      if (existing) return existing._id;
    }

    return await ctx.db.insert("mcpApprovals", {
      projectId: args.projectId,
      ownerId: project.ownerId,
      messageId: args.messageId,
      projectConnectionId: args.projectConnectionId,
      providerId: args.providerId,
      toolName: args.toolName,
      argsPreview: args.argsPreview,
      status: "pending" as const,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
      mcpInvocationId: args.mcpInvocationId,
    });
  },
});

/**
 * Take the single-use claim on an approved action.
 *
 * Returns true to the first caller and false to every later one. Convex mutations
 * are serializable transactions, so the read and the patch cannot interleave with
 * a competing claim — which is what makes this a safe guard against a mutating MCP
 * call being reissued when its workflow step is retried after losing its result.
 *
 * Failing closed is deliberate: a row that is missing, unapproved or already
 * consumed all return false, because none of those states establish that it is
 * safe to send a migration again.
 */
export const claimMcpApproval = mutation({
  args: {
    internalKey: v.string(),
    approvalId: v.id("mcpApprovals"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const approval = await ctx.db.get("mcpApprovals", args.approvalId);
    if (!approval) return false;
    if (approval.status !== "approved") return false;
    if (approval.consumedAt !== undefined) return false;

    await ctx.db.patch("mcpApprovals", args.approvalId, {
      consumedAt: Date.now(),
    });

    return true;
  },
});

/** Read one approval. Polled by the agent from inside a durable step. */
export const getMcpApproval = query({
  args: {
    internalKey: v.string(),
    approvalId: v.id("mcpApprovals"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await ctx.db.get("mcpApprovals", args.approvalId);
  },
});

export const expireMcpApproval = mutation({
  args: {
    internalKey: v.string(),
    approvalId: v.id("mcpApprovals"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const approval = await ctx.db.get("mcpApprovals", args.approvalId);
    if (!approval || approval.status !== "pending") return;

    await ctx.db.patch("mcpApprovals", args.approvalId, {
      status: "expired" as const,
      resolvedAt: Date.now(),
    });
  },
});

export const recordMcpToolCall = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    providerId: v.string(),
    toolName: v.string(),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("denied"),
      v.literal("blocked"),
    ),
    argsDigest: v.string(),
    redactionSummary: v.optional(v.string()),
    durationMs: v.number(),
    errorMessage: v.optional(v.string()),
    mcpInvocationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    // Idempotent per (invocation, status), for the same reason as the approval
    // row: the audit write is already inside a memoized step, and this closes the
    // window where a lost checkpoint would duplicate the row. Keyed on status as
    // well as invocation because one invocation can legitimately record two
    // outcomes — for example `denied` and then nothing, or `blocked` after a lost
    // claim.
    if (args.mcpInvocationId) {
      const existing = await ctx.db
        .query("mcpToolAuditLog")
        .withIndex("by_invocation", (q) =>
          q.eq("mcpInvocationId", args.mcpInvocationId),
        )
        // One row per status this invocation recorded, so a handful at most.
        .collect();

      if (existing.some((row) => row.status === args.status)) return;
    }

    const project = await ctx.db.get("projects", args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    await ctx.db.insert("mcpToolAuditLog", {
      projectId: args.projectId,
      ownerId: project.ownerId,
      providerId: args.providerId,
      toolName: args.toolName,
      status: args.status,
      argsDigest: args.argsDigest,
      redactionSummary: args.redactionSummary,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage,
      createdAt: Date.now(),
      mcpInvocationId: args.mcpInvocationId,
    });
  },
});


/**
 * Read a project row.
 *
 * Used by the agent to resolve the project owner, which approval rows and audit
 * entries are attributed to. Read from the project rather than passed in, so an
 * approval prompt can only ever be shown to the person who owns the work.
 */
export const getProjectById = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await ctx.db.get("projects", args.projectId);
  },
});

/** The project when `userId` owns it and it is not being deleted, else `null`. */
const ownedProjectOrNull = async (
  ctx: QueryCtx,
  projectId: Id<"projects">,
  userId: string,
) => {
  const project = await ctx.db.get("projects", projectId);
  return project?.ownerId === userId && project.deletingAt === undefined
    ? project
    : null;
};

/**
 * The project when `userId` owns it, else `null`: missing, someone else's and
 * malformed ids all look the same, so API routes can answer 404 to all three
 * without revealing which projects exist (#208).
 */
export const getOwnedProject = query({
  args: {
    internalKey: v.string(),
    projectId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    return projectId ? await ownedProjectOrNull(ctx, projectId, args.userId) : null;
  },
});

/** `getOwnedProject` for a conversation: `null` unless `userId` owns its project. */
export const getOwnedConversation = query({
  args: {
    internalKey: v.string(),
    conversationId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const conversationId = ctx.db.normalizeId("conversations", args.conversationId);
    const conversation = conversationId
      ? await ctx.db.get("conversations", conversationId)
      : null;
    if (!conversation) return null;
    const project = await ownedProjectOrNull(ctx, conversation.projectId, args.userId);
    return project ? conversation : null;
  },
});


/**
 * Create or replace a public environment variable from the server.
 *
 * The `envVars.setPublicEnvVar` counterpart is client-callable and authenticates
 * the user; this one is `internalKey`-gated for the agent, which acts on the
 * project owner's behalf and has no user session.
 *
 * Public values are stored in plaintext because they are public by definition — a
 * `NEXT_PUBLIC_` variable is inlined into client JavaScript by the bundler whatever
 * we do here, so encrypting it would add a decrypt step to every preview boot while
 * protecting nothing.
 */
export const setPublicEnvVarInternal = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    // The row's ownerId decides who may delete it later (`envVars.deleteEnvVar`),
    // so it must be the project's real owner (#211).
    if (!(await ownedProjectOrNull(ctx, args.projectId, args.ownerId))) {
      throw appError("NOT_FOUND", "Project not found");
    }

    const existing = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", args.key)
      )
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch("projectEnvVars", existing._id, {
        visibility: "public" as const,
        plainValue: args.value,
        maskedPreview: args.value,
        // Clear any sealed payload from when this key was a secret, so the row does
        // not carry two competing values.
        secretRef: undefined,
        kekProvider: undefined,
        kekKeyId: undefined,
        wrappedDek: undefined,
        ciphertext: undefined,
        iv: undefined,
        authTag: undefined,
        source: "integration" as const,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("projectEnvVars", {
      projectId: args.projectId,
      ownerId: args.ownerId,
      key: args.key,
      visibility: "public" as const,
      plainValue: args.value,
      maskedPreview: args.value,
      source: "integration" as const,
      updatedAt: now,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// AI provider keys (BYOK)
//
// Same contract as the integrations above: the Next.js routes test and seal a
// key, Convex stores only ciphertext, and every read is owner-scoped so
// internalKey is not a master key over every user's keys.
// ─────────────────────────────────────────────────────────────────────────────

export const createAiProviderKey = mutation({
  args: {
    internalKey: v.string(),
    userId: v.string(),
    provider: aiProviderValidator,
    label: v.string(),
    baseUrl: v.optional(v.string()),
    modelIds: v.optional(v.array(v.string())),
    secretRef: v.string(),
    maskedPreview: v.string(),
    ...sealedFields,
  },
  handler: async (ctx, { internalKey, ...args }) => {
    validateInternalKey(internalKey);

    const now = Date.now();
    // Only stored after a successful connection test.
    return await ctx.db.insert("aiProviderKeys", {
      ...args,
      status: "active",
      lastTestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateAiProviderKeyStatus = mutation({
  args: {
    internalKey: v.string(),
    keyId: v.id("aiProviderKeys"),
    userId: v.string(),
    status: v.union(v.literal("active"), v.literal("invalid")),
    statusMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const key = await ctx.db.get("aiProviderKeys", args.keyId);
    if (!key || key.userId !== args.userId) {
      throw appError("NOT_FOUND", "AI provider key not found");
    }

    const now = Date.now();
    await ctx.db.patch("aiProviderKeys", args.keyId, {
      status: args.status,
      statusMessage: args.statusMessage,
      lastTestedAt: now,
      updatedAt: now,
    });
  },
});

/** The sealed key, only when `userId` owns it. For the test-connection route. */
export const getAiProviderKeyForUser = query({
  args: {
    internalKey: v.string(),
    keyId: v.id("aiProviderKeys"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const key = await ctx.db.get("aiProviderKeys", args.keyId);
    return key && key.userId === args.userId ? key : null;
  },
});

/**
 * The user's default key (sealed) and model, for the editor AI routes. Null when
 * the default is the platform, so the caller uses Codenaya's model. A default
 * whose key no longer exists comes back as `key: null`.
 */
export const getDefaultAiProviderKey = query({
  args: {
    internalKey: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const preferences = await ctx.db
      .query("userAiPreferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!preferences?.defaultKeyId) {
      return null;
    }

    const key = await ctx.db.get("aiProviderKeys", preferences.defaultKeyId);
    return {
      key: key && key.userId === args.userId ? key : null,
      modelId: preferences.defaultModelId,
    };
  },
});

/**
 * The sealed key for an agent run, only when the key's owner is the project's
 * owner, so a wrong or crafted keyId cannot spend another user's key.
 */
export const getAiProviderKeyForRun = query({
  args: {
    internalKey: v.string(),
    keyId: v.id("aiProviderKeys"),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const project = await ctx.db.get("projects", args.projectId);
    const key = await ctx.db.get("aiProviderKeys", args.keyId);
    return project && key && key.userId === project.ownerId ? key : null;
  },
});

/** Records that an agent run used the key, for the settings page. */
export const markAiProviderKeyUsed = mutation({
  args: {
    internalKey: v.string(),
    keyId: v.id("aiProviderKeys"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const key = await ctx.db.get("aiProviderKeys", args.keyId);
    if (key) {
      await ctx.db.patch("aiProviderKeys", args.keyId, { lastUsedAt: Date.now() });
    }
  },
});

// ─── Skills ───

/**
 * The project's enabled skills, with bodies, for the agent's skill index.
 * Only the project owner's skills are read, as in `getProjectMcpConnections`.
 */
export const getProjectSkills = query({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const project = await ctx.db.get("projects", args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const skills = await resolveProjectSkills(ctx, project);
    return skills.filter((skill) => skill.enabled);
  },
});

/**
 * Credits (#105). The domain logic lives in `convex/credits.ts`; these are the
 * internal-key wrappers the Next.js route and the Inngest run call.
 */

/** Pre-run gate: throws `INSUFFICIENT_CREDITS` when the account cannot pay. */
export const assertCanRun = mutation({
  args: {
    internalKey: v.string(),
    userId: v.string(),
    byok: v.boolean(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await assertCanRunForUser(ctx, args);
  },
});

/** Post-run charge, idempotent on the assistant message id. */
export const chargeRun = mutation({
  args: {
    internalKey: v.string(),
    userId: v.string(),
    messageId: v.id("messages"),
    byok: v.boolean(),
    model: v.optional(v.string()),
    costUsd: v.number(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const { internalKey: _internalKey, ...charge } = args;
    return await chargeRunForUser(ctx, charge);
  },
});

/** The account, for the billing routes (e.g. top-ups are Pro-only). */
export const getCreditAccount = query({
  args: {
    internalKey: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await readAccountView(ctx, args.userId);
  },
});
