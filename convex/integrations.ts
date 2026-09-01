import { v } from "convex/values";

import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx, mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";

/**
 * User-facing integration functions, called from React through the
 * authenticated Convex client.
 *
 * ## What is deliberately absent
 *
 * Nothing here writes or returns credential material. Sealing requires
 * `node:crypto` and the KEK, neither of which belongs in the Convex runtime, so
 * every secret write happens in a Next.js route handler and lands via the
 * `internalKey`-gated mutations in `system.ts`.
 *
 * Reads here return *summaries* built by an explicit field allowlist. That is
 * the important detail: a denylist would silently start leaking the moment a new
 * sealed field is added to the schema, whereas an allowlist fails closed.
 */

/** Connection fields that are safe to send to the browser. */
export interface UserConnectionSummary {
  _id: Id<"userConnections">;
  providerId: string;
  label: string;
  authMode: "oauth" | "api_key";
  serverUrl: string;
  status: "active" | "needs_reauth" | "revoked" | "error";
  statusMessage?: string;
  maskedPreview: string;
  scopes: string[];
  tokenExpiresAt?: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Project a stored connection down to browser-safe fields.
 *
 * Written as an explicit allowlist rather than `{ ...doc, ciphertext: undefined }`
 * so that adding a sealed field to the schema cannot accidentally widen what the
 * client receives.
 */
function toConnectionSummary(doc: Doc<"userConnections">): UserConnectionSummary {
  return {
    _id: doc._id,
    providerId: doc.providerId,
    label: doc.label,
    authMode: doc.authMode,
    serverUrl: doc.serverUrl,
    status: doc.status,
    statusMessage: doc.statusMessage,
    maskedPreview: doc.maskedPreview,
    scopes: doc.scopes,
    tokenExpiresAt: doc.tokenExpiresAt,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Assert the caller owns `projectId`, returning the project.
 *
 * Exported for `envVars.ts`, which enforces the same boundary.
 */
export async function assertProjectOwner(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  userId: string,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get("projects", projectId);

  if (!project) {
    throw new Error("Project not found");
  }

  if (project.ownerId !== userId) {
    throw new Error("Unauthorized to access this project");
  }

  return project;
}

async function assertConnectionOwner(
  ctx: QueryCtx | MutationCtx,
  connectionId: Id<"userConnections">,
  userId: string,
): Promise<Doc<"userConnections">> {
  const connection = await ctx.db.get("userConnections", connectionId);

  if (!connection) {
    throw new Error("Connection not found");
  }

  if (connection.userId !== userId) {
    throw new Error("Unauthorized to access this connection");
  }

  return connection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** Every connection the signed-in user holds, newest first. */
export const listUserConnections = query({
  args: {},
  handler: async (ctx): Promise<UserConnectionSummary[]> => {
    const identity = await verifyAuth(ctx);

    const connections = await ctx.db
      .query("userConnections")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();

    return connections
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toConnectionSummary);
  },
});

/**
 * Connections attached to one project, each with the scope that project uses.
 *
 * Returns the link row plus a summary of the underlying credential so the UI can
 * render a project's integrations in a single round trip.
 */
export const listProjectConnections = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await assertProjectOwner(ctx, args.projectId, identity.subject);

    const links = await ctx.db
      .query("projectConnections")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const results = [];
    for (const link of links) {
      const connection = await ctx.db.get(
        "userConnections",
        link.userConnectionId,
      );

      // A link whose credential was deleted is stale rather than fatal; skip it
      // so a partially-cascaded delete cannot break the whole panel.
      if (!connection) continue;

      results.push({
        _id: link._id,
        projectId: link.projectId,
        userConnectionId: link.userConnectionId,
        enabled: link.enabled,
        readOnly: link.readOnly,
        providerScope: link.providerScope,
        allowedTools: link.allowedTools,
        writeApproved: link.writeApproved,
        toolCount: link.toolBaseline?.length,
        toolBaselineAt: link.toolBaselineAt,
        connection: toConnectionSummary(connection),
      });
    }

    return results.sort((a, b) =>
      a.connection.providerId.localeCompare(b.connection.providerId),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
//
// Only non-secret operations live here. Anything that needs to seal or unseal a
// credential goes through system.ts.
// ─────────────────────────────────────────────────────────────────────────────

const providerScopeValidator = v.object({
  projectRef: v.optional(v.string()),
  categories: v.optional(v.array(v.string())),
  features: v.optional(v.array(v.string())),
  toolsets: v.optional(v.array(v.string())),
  orgSlug: v.optional(v.string()),
  projectSlug: v.optional(v.string()),
});

/** Attach one of the user's connections to one of their projects. */
export const linkConnectionToProject = mutation({
  args: {
    projectId: v.id("projects"),
    userConnectionId: v.id("userConnections"),
    readOnly: v.optional(v.boolean()),
    providerScope: v.optional(providerScopeValidator),
    allowedTools: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    // Both sides must belong to the caller. Checking only the project would let
    // a user borrow someone else's credential into their own project.
    await assertProjectOwner(ctx, args.projectId, identity.subject);
    await assertConnectionOwner(ctx, args.userConnectionId, identity.subject);

    const existing = await ctx.db
      .query("projectConnections")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const duplicate = existing.find(
      (link) => link.userConnectionId === args.userConnectionId,
    );
    if (duplicate) {
      throw new Error("This connection is already linked to the project");
    }

    const now = Date.now();

    return await ctx.db.insert("projectConnections", {
      projectId: args.projectId,
      userConnectionId: args.userConnectionId,
      ownerId: identity.subject,
      enabled: true,
      // Read-only unless the user opts out. A new integration should not be able
      // to mutate infrastructure until that is an explicit choice.
      readOnly: args.readOnly ?? true,
      providerScope: args.providerScope ?? {},
      allowedTools: args.allowedTools,
      writeApproved: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Change a project connection's scope or state.
 *
 * Any change to scope or the read-only flag clears the tool baseline: the set of
 * tools the server exposes depends on that scope, so a stale baseline would
 * either raise false drift alarms or, worse, silently accept tools that were
 * never reviewed.
 */
export const updateProjectConnection = mutation({
  args: {
    id: v.id("projectConnections"),
    enabled: v.optional(v.boolean()),
    readOnly: v.optional(v.boolean()),
    providerScope: v.optional(providerScopeValidator),
    allowedTools: v.optional(v.array(v.string())),
    writeApproved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const link = await ctx.db.get("projectConnections", args.id);
    if (!link) {
      throw new Error("Project connection not found");
    }
    if (link.ownerId !== identity.subject) {
      throw new Error("Unauthorized to update this project connection");
    }

    const scopeChanged =
      args.providerScope !== undefined ||
      (args.readOnly !== undefined && args.readOnly !== link.readOnly) ||
      args.allowedTools !== undefined;

    await ctx.db.patch("projectConnections", args.id, {
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.readOnly !== undefined ? { readOnly: args.readOnly } : {}),
      ...(args.providerScope !== undefined
        ? { providerScope: args.providerScope }
        : {}),
      ...(args.allowedTools !== undefined
        ? { allowedTools: args.allowedTools }
        : {}),
      ...(args.writeApproved !== undefined
        ? { writeApproved: args.writeApproved }
        : {}),
      ...(scopeChanged
        ? { toolBaseline: undefined, toolBaselineAt: undefined }
        : {}),
      updatedAt: Date.now(),
    });
  },
});

export const unlinkProjectConnection = mutation({
  args: { id: v.id("projectConnections") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const link = await ctx.db.get("projectConnections", args.id);
    if (!link) {
      throw new Error("Project connection not found");
    }
    if (link.ownerId !== identity.subject) {
      throw new Error("Unauthorized to unlink this project connection");
    }

    await ctx.db.delete("projectConnections", args.id);
  },
});

/**
 * Delete a credential and every project link that depends on it.
 *
 * Links are removed first so no window exists in which a link points at a
 * missing credential.
 */
export const deleteUserConnection = mutation({
  args: { id: v.id("userConnections") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await assertConnectionOwner(ctx, args.id, identity.subject);

    const links = await ctx.db
      .query("projectConnections")
      .withIndex("by_userConnection", (q) => q.eq("userConnectionId", args.id))
      .collect();

    for (const link of links) {
      await ctx.db.delete("projectConnections", link._id);
    }

    // Env vars written by this integration are intentionally left in place:
    // deleting a credential should not silently break a running app. They are
    // marked with `sourceConnectionId` so the UI can offer removal separately.
    await ctx.db.delete("userConnections", args.id);

    return { unlinkedProjects: links.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Approvals (human-in-the-loop gate for destructive tools)
// ─────────────────────────────────────────────────────────────────────────────

/** Pending approval requests for a project, oldest first. */
export const listPendingApprovals = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await assertProjectOwner(ctx, args.projectId, identity.subject);

    const pending = await ctx.db
      .query("mcpApprovals")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending"),
      )
      .collect();

    const now = Date.now();

    // Filter expired rows at read time rather than trusting the cron to have run.
    // Showing a stale prompt would invite the user to approve an action whose
    // agent has already given up waiting.
    return pending
      .filter((row) => row.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

/** Approve or deny a pending tool call. */
export const resolveApproval = mutation({
  args: {
    id: v.id("mcpApprovals"),
    decision: v.union(v.literal("approved"), v.literal("denied")),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const approval = await ctx.db.get("mcpApprovals", args.id);
    if (!approval) {
      throw new Error("Approval request not found");
    }
    if (approval.ownerId !== identity.subject) {
      throw new Error("Unauthorized to resolve this approval");
    }
    if (approval.status !== "pending") {
      throw new Error(`This request was already ${approval.status}`);
    }
    if (approval.expiresAt <= Date.now()) {
      // Record the expiry so the row reflects reality, then refuse. Approving
      // after the agent stopped waiting would leave the user believing an action
      // ran when it did not.
      await ctx.db.patch("mcpApprovals", args.id, {
        status: "expired",
        resolvedAt: Date.now(),
      });
      throw new Error("This request expired before it was answered");
    }

    await ctx.db.patch("mcpApprovals", args.id, {
      status: args.decision,
      resolvedAt: Date.now(),
    });
  },
});
