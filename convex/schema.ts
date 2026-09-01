import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    ownerId: v.string(),
    updatedAt: v.number(),
    importStatus: v.optional(
      v.union(
        v.literal("importing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    exportStatus: v.optional(
      v.union(
        v.literal("exporting"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
    ),
    exportRepoUrl: v.optional(v.string()),
    settings: v.optional(
      v.object({
        installCommand: v.optional(v.string()),
        devCommand: v.optional(v.string()),
      })
    ),
  }).index("by_owner", ["ownerId"]),

  files: defineTable({
    projectId: v.id("projects"),
    parentId: v.optional(v.id("files")),
    name: v.string(),
    type: v.union(v.literal("file"), v.literal("folder")),
    content: v.optional(v.string()), // Text files only
    storageId: v.optional(v.id("_storage")), // Binary files only
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["parentId"])
    .index("by_project_parent", ["projectId", "parentId"]),

  conversations: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  messages: defineTable({
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
    // Workflow run id (when processed via Vercel Workflow SDK)
    workflowRunId: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_project_status", ["projectId", "status"]),

  // ─── Showcase ───
  showcaseProjects: defineTable({
    projectId: v.id("projects"),
    ownerId: v.string(),
    ownerName: v.string(),
    ownerAvatarUrl: v.optional(v.string()),
    title: v.string(),
    description: v.string(),
    previewImageId: v.optional(v.id("_storage")),
    techStack: v.array(v.string()),
    designStyle: v.array(v.string()),
    category: v.string(),
    upvotes: v.number(),
    downvotes: v.number(),
    viewCount: v.number(),
    importCount: v.number(),
    status: v.union(
      v.literal("published"),
      v.literal("removed"),
    ),
    publishedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_publishedAt", ["status", "publishedAt"])
    .index("by_status_and_upvotes", ["status", "upvotes"])
    .index("by_owner", ["ownerId"])
    .index("by_projectId", ["projectId"])
    .index("by_status_and_category", ["status", "category"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["status", "category"],
    }),

  showcaseVotes: defineTable({
    showcaseProjectId: v.id("showcaseProjects"),
    userId: v.string(),
    vote: v.union(v.literal("up"), v.literal("down")),
    createdAt: v.number(),
  })
    .index("by_userId_and_showcaseProjectId", ["userId", "showcaseProjectId"])
    .index("by_showcaseProjectId", ["showcaseProjectId"]),

  showcaseViews: defineTable({
    showcaseProjectId: v.id("showcaseProjects"),
    userId: v.string(),
    viewedAt: v.number(),
  })
    .index("by_userId_and_showcaseProjectId", ["userId", "showcaseProjectId"])
    .index("by_showcaseProjectId", ["showcaseProjectId"]),

  // ─── Integrations (MCP servers + runtime env vars) ───
  //
  // Credential storage uses envelope encryption (see
  // src/features/integrations/server/crypto). Only wrapped DEKs and ciphertext
  // live here; the KEK never touches the database. Every sealed record carries
  // `kekProvider` + `kekKeyId` so a KEK migration can proceed incrementally
  // while old and new rows remain readable side by side.
  //
  // Ciphertexts are bound to their own row by AAD, keyed on the immutable
  // `credentialRef`/`secretRef` nanoid rather than the Convex `_id`. Using a
  // pre-generated ref means a row can be inserted in a single write (the `_id`
  // is not known until after insert) and guarantees the AAD anchor never
  // changes for the life of the record.

  /**
   * A credential the user holds for one provider, owned at the user level so a
   * single Supabase authorization can be reused across many projects. Per-project
   * scoping lives in `projectConnections`.
   */
  userConnections: defineTable({
    userId: v.string(),
    // Catalog provider id, or "custom" for a user-supplied MCP server URL.
    providerId: v.string(),
    label: v.string(),
    authMode: v.union(v.literal("oauth"), v.literal("api_key")),
    // Base MCP endpoint before per-project scoping is applied.
    serverUrl: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("needs_reauth"),
      v.literal("revoked"),
      v.literal("error"),
    ),
    statusMessage: v.optional(v.string()),

    // ── Sealed credential bundle (JSON: access token, refresh token, ...) ──
    credentialRef: v.string(),
    kekProvider: v.string(),
    kekKeyId: v.string(),
    wrappedDek: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    authTag: v.string(),

    // Safe to render in the UI, e.g. "sbp_…3f2a". Never the full secret.
    maskedPreview: v.string(),

    // ── Non-secret OAuth metadata ──
    scopes: v.array(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    oauthClientId: v.optional(v.string()),
    authServerUrl: v.optional(v.string()),

    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_provider", ["userId", "providerId"]),

  /**
   * Links a `userConnections` row to one project, with the scope that project is
   * allowed to use. The same credential can be attached to several projects with
   * different scopes (for example a different Supabase `project_ref` each time).
   */
  projectConnections: defineTable({
    projectId: v.id("projects"),
    userConnectionId: v.id("userConnections"),
    // Denormalised from the project so ownership can be checked without a
    // second read on every agent turn.
    ownerId: v.string(),
    enabled: v.boolean(),

    // Read-only is the default posture. For providers whose MCP endpoint cannot
    // express it (Stripe, Context7, Prisma, Cloudflare, Sentry) this flag is
    // still honoured by the destructive-tool approval gate.
    readOnly: v.boolean(),
    // Feeds ProjectScopeSelection in scope-url.ts.
    providerScope: v.object({
      projectRef: v.optional(v.string()),
      categories: v.optional(v.array(v.string())),
      features: v.optional(v.array(v.string())),
      toolsets: v.optional(v.array(v.string())),
      orgSlug: v.optional(v.string()),
      projectSlug: v.optional(v.string()),
    }),
    // When set, only these tool names are exposed to the model. Protects the
    // context budget; a wide-open server can cost more schema tokens than the
    // whole window.
    allowedTools: v.optional(v.array(v.string())),
    // True once the user has accepted that this connection may perform writes.
    writeApproved: v.boolean(),

    // Approved tool fingerprints, for detecting an MCP server that silently
    // changes a tool's description or schema after we trusted it ("rug pull").
    toolBaseline: v.optional(
      v.array(v.object({ name: v.string(), digest: v.string() })),
    ),
    toolBaselineAt: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_enabled", ["projectId", "enabled"])
    .index("by_userConnection", ["userConnectionId"]),

  /**
   * Environment variables injected into a project's preview at runtime.
   *
   * `visibility` is the security boundary between the two preview backends.
   * Public values are stored in plaintext because they are public by definition,
   * which keeps the common path free of crypto entirely. Secret values are
   * sealed and are never sent to the browser — WebContainer runs in-page, so
   * anything mounted there is readable by the end user.
   */
  projectEnvVars: defineTable({
    projectId: v.id("projects"),
    ownerId: v.string(),
    key: v.string(),
    visibility: v.union(v.literal("public"), v.literal("secret")),

    // Set only when visibility === "public".
    plainValue: v.optional(v.string()),

    // Set only when visibility === "secret".
    secretRef: v.optional(v.string()),
    kekProvider: v.optional(v.string()),
    kekKeyId: v.optional(v.string()),
    wrappedDek: v.optional(v.string()),
    ciphertext: v.optional(v.string()),
    iv: v.optional(v.string()),
    authTag: v.optional(v.string()),

    maskedPreview: v.string(),
    // "integration" values were written by the agent while provisioning.
    source: v.union(v.literal("manual"), v.literal("integration")),
    sourceConnectionId: v.optional(v.id("userConnections")),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "key"]),

  /**
   * In-flight OAuth authorization codes. Short-lived; pruned by cron.
   *
   * The PKCE code verifier is sealed rather than stored plainly: it is the
   * secret half of the exchange, and a leaked verifier plus an intercepted code
   * is enough to steal the resulting token.
   */
  oauthFlowStates: defineTable({
    state: v.string(),
    userId: v.string(),
    providerId: v.string(),
    serverUrl: v.string(),
    redirectUri: v.string(),

    // Sealed PKCE verifier, anchored on `state`.
    kekProvider: v.string(),
    kekKeyId: v.string(),
    wrappedDek: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    authTag: v.string(),

    // Present when the client was registered dynamically (RFC 7591).
    oauthClientId: v.optional(v.string()),
    authServerUrl: v.string(),
    // Expected `iss` on the callback. A mismatch aborts the code exchange.
    issuer: v.optional(v.string()),

    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Human-in-the-loop gate for destructive MCP tool calls.
   *
   * The agent polls its own row from inside a durable step. Polling rather than
   * a backend-specific signal keeps the behaviour identical across the Inngest
   * and Workflow backends, which matters because one is the other's fallback.
   */
  mcpApprovals: defineTable({
    projectId: v.id("projects"),
    ownerId: v.string(),
    messageId: v.optional(v.id("messages")),
    projectConnectionId: v.id("projectConnections"),
    providerId: v.string(),
    toolName: v.string(),
    // Redacted argument summary for display. Never raw credential material.
    argsPreview: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_message", ["messageId"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Audit trail of MCP tool invocations.
   *
   * Arguments are stored as a digest, not verbatim, so the log cannot become a
   * secondary store of whatever secrets a tool call carried. Pruned by cron to
   * stay inside the Convex free-tier storage budget.
   */
  mcpToolAuditLog: defineTable({
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
    createdAt: v.number(),
  })
    .index("by_project_and_createdAt", ["projectId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
});
