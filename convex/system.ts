import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const validateInternalKey = (key: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    throw new Error("CODENAYA_CONVEX_INTERNAL_KEY is not configured");
  }

  if (key !== internalKey) {
    throw new Error("Invalid internal key");
  }
};

export const getConversationById = query({
  args: {
    conversationId: v.id("conversations"),
    internalKey: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.get(args.conversationId);
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
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      status: args.status,
    });

    // Update conversation's updatedAt
    await ctx.db.patch(args.conversationId, {
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

    await ctx.db.patch(args.messageId, {
      content: args.content,
      status: "completed" as const,
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

    await ctx.db.patch(args.messageId, {
      status: args.status,
    });
  },
});

export const setMessageWorkflowRunId = mutation({
  args: {
    internalKey: v.string(),
    messageId: v.id("messages"),
    workflowRunId: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch(args.messageId, {
      workflowRunId: args.workflowRunId,
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

    return await ctx.db.get(args.messageId);
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
      .collect();
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

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("asc")
      .collect();

    const limit = args.limit ?? 10;
    return messages.slice(-limit);
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

    await ctx.db.patch(args.conversationId, {
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
      .collect();
  },
});

// Used for Agent "ReadFiles" tool
export const getFileById = query({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.get(args.fileId);
  },
});

// Used for Agent "UpdateFile" tool
export const updateFile = mutation({
  args: {
    internalKey: v.string(),
    fileId: v.id("files"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await ctx.db.get(args.fileId);

    if (!file) {
      throw new Error("File not found");
    }

    await ctx.db.patch(args.fileId, {
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

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId)
      )
      .collect();

    const existing = files.find(
      (file) => file.name === args.name && file.type === "file"
    );

    if (existing) {
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

    const existingFiles = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId)
      )
      .collect();

    const results: { name: string; fileId: string; error?: string }[] = [];

    for (const file of args.files) {
      const existing = existingFiles.find(
        (f) => f.name === file.name && f.type === "file"
      );

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

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId)
      )
      .collect();

    const existing = files.find(
      (file) => file.name === args.name && file.type === "folder"
    );

    if (existing) {
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
    fileId: v.id("files"),
    newName: v.string(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const file = await ctx.db.get(args.fileId);
    if (!file) {
      throw new Error("File not found");
    }

    // Check if a file with the new name already exists in the same parent folder
    const siblings = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", file.projectId).eq("parentId", file.parentId)
      )
      .collect();

    const existing = siblings.find(
      (sibling) =>
        sibling.name === args.newName &&
        sibling.type === file.type &&
        sibling._id !== args.fileId
    );

    if (existing) {
      throw new Error(`A ${file.type} named "${args.newName}" already exists`);
    }

    await ctx.db.patch(args.fileId, {
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
    fileId: v.id("files"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

     const file = await ctx.db.get(args.fileId);
    if (!file) {
      throw new Error("File not found");
    }

    // Recursively delete file/folder and all descendants
    const deleteRecursive = async (fileId: typeof args.fileId) => {
      const item = await ctx.db.get(fileId);

      if (!item) {
        return;
      }

      // If it's a folder, delete all children first
      if (item.type === "folder") {
        const children = await ctx.db
          .query("files")
          .withIndex("by_project_parent", (q) =>
            q.eq("projectId", item.projectId).eq("parentId", fileId)
          )
          .collect();

        for (const child of children) {
          await deleteRecursive(child._id);
        }
      }

      // Delete storage file if it exists
      if (item.storageId) {
        await ctx.storage.delete(item.storageId);
      }

      // Delete the file/folder itself
      await ctx.db.delete(fileId);
    };

    await deleteRecursive(args.fileId);

    return args.fileId;
  },
});

export const cleanup = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const file of files) {
      // Delete storage file if it exists
      if (file.storageId) {
        await ctx.storage.delete(file.storageId);
      }

      await ctx.db.delete(file._id);
    }

    return { deleted: files.length };
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

    const files = await ctx.db
      .query("files")
      .withIndex("by_project_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentId", args.parentId)
      )
      .collect();

    const existing = files.find(
      (file) => file.name === args.name && file.type === "file"
    );

    if (existing) {
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
      .collect();

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

    const now = Date.now();

    return await ctx.db.insert("userConnections", {
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
  },
});

/**
 * Replace a connection's sealed credential, used after an OAuth token refresh.
 *
 * `credentialRef` is intentionally *not* updatable: it anchors the AAD that binds
 * the ciphertext to this row, so changing it would make every existing
 * ciphertext undecryptable.
 */
export const updateUserConnectionCredential = mutation({
  args: {
    internalKey: v.string(),
    connectionId: v.id("userConnections"),
    maskedPreview: v.string(),
    scopes: v.optional(v.array(v.string())),
    tokenExpiresAt: v.optional(v.number()),
    ...sealedFields,
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const connection = await ctx.db.get("userConnections", args.connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    await ctx.db.patch("userConnections", args.connectionId, {
      kekProvider: args.kekProvider,
      kekKeyId: args.kekKeyId,
      wrappedDek: args.wrappedDek,
      ciphertext: args.ciphertext,
      iv: args.iv,
      authTag: args.authTag,
      maskedPreview: args.maskedPreview,
      ...(args.scopes !== undefined ? { scopes: args.scopes } : {}),
      ...(args.tokenExpiresAt !== undefined
        ? { tokenExpiresAt: args.tokenExpiresAt }
        : {}),
      status: "active" as const,
      statusMessage: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const updateUserConnectionStatus = mutation({
  args: {
    internalKey: v.string(),
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

    await ctx.db.patch("userConnections", args.connectionId, {
      status: args.status,
      statusMessage: args.statusMessage,
      updatedAt: Date.now(),
    });
  },
});

export const markUserConnectionUsed = mutation({
  args: {
    internalKey: v.string(),
    connectionId: v.id("userConnections"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.patch("userConnections", args.connectionId, {
      lastUsedAt: Date.now(),
    });
  },
});

export const getUserConnectionById = query({
  args: {
    internalKey: v.string(),
    connectionId: v.id("userConnections"),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    return await ctx.db.get("userConnections", args.connectionId);
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
      .collect();

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
      .collect();
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

    return await ctx.db.insert("oauthFlowStates", {
      state: args.state,
      userId: args.userId,
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
    ownerId: v.string(),
    messageId: v.optional(v.id("messages")),
    projectConnectionId: v.id("projectConnections"),
    providerId: v.string(),
    toolName: v.string(),
    argsPreview: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    return await ctx.db.insert("mcpApprovals", {
      projectId: args.projectId,
      ownerId: args.ownerId,
      messageId: args.messageId,
      projectConnectionId: args.projectConnectionId,
      providerId: args.providerId,
      toolName: args.toolName,
      argsPreview: args.argsPreview,
      status: "pending" as const,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
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
    ownerId: v.string(),
    providerId: v.string(),
    toolName: v.string(),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("denied"),
      v.literal("blocked"),
    ),
    argsDigest: v.string(),
    durationMs: v.number(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    await ctx.db.insert("mcpToolAuditLog", {
      projectId: args.projectId,
      ownerId: args.ownerId,
      providerId: args.providerId,
      toolName: args.toolName,
      status: args.status,
      argsDigest: args.argsDigest,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage,
      createdAt: Date.now(),
    });
  },
});
