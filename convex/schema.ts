import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One row of an agent run, recorded for display only (the chat panel's
 * "Worked for Xs" block). `targets` are human-readable paths, URLs or env keys,
 * never document ids or values. Upserted by `id` (the tool call id), so a
 * replayed agent turn rewrites the same rows instead of adding new ones.
 */
export const messageStepValidator = v.object({
  id: v.string(),
  kind: v.union(v.literal("tool"), v.literal("thinking")),
  tool: v.optional(v.string()),
  targets: v.optional(v.array(v.string())),
  text: v.optional(v.string()),
  status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
  error: v.optional(v.string()),
  startedAt: v.number(),
  endedAt: v.optional(v.number()),
});

export const aiProviderValidator = v.union(
  v.literal("openrouter"),
  v.literal("openai"),
  v.literal("anthropic"),
  v.literal("custom"),
);

/**
 * The model an assistant message was produced with. `keyId` is set when the
 * run used the user's own key (BYOK), which is what billing reads to charge no
 * credits. `label` is the "provider · model" shown on the run block.
 */
export const runModelValidator = v.object({
  keyId: v.optional(v.id("aiProviderKeys")),
  modelId: v.string(),
  label: v.string(),
});

export default defineSchema({
  /**
   * Profile mirror of a Clerk user, kept in sync by the Clerk webhook
   * (`convex/http.ts`). Ownership everywhere else stays keyed on
   * `identity.subject`, which is this row's `clerkUserId`.
   *
   * A deleted user keeps a tombstone (`deletedAt`) so a late or replayed
   * `user.updated` event cannot recreate the row after its data was purged.
   */
  users: defineTable({
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_clerkUserId", ["clerkUserId"]),

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
    // Set when the owner deletes the project. The project is hidden at once
    // while `projects.deleteBatch` removes its data in the background.
    deletingAt: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]),

  /**
   * Denormalized running totals, one row per `name`, so public pages can show
   * a number without scanning a table. See `convex/stats.ts`.
   */
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

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
    // Agent activity for the chat panel. Bounded: see MAX_MESSAGE_STEPS.
    steps: v.optional(v.array(messageStepValidator)),
    // When the run stopped (completed or cancelled), for "Worked for Xs".
    completedAt: v.optional(v.number()),
    // Assistant messages only: the model the run used.
    runModel: v.optional(runModelValidator),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_project_status", ["projectId", "status"])
    // For the lost-run sweep in maintenance.ts.
    .index("by_status", ["status"]),

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

  // ─── Skills ───

  /**
   * A user's Agent Skill (`SKILL.md` shape). Without `projectId` it is a
   * library skill the owner can enable per project; with it, the skill exists
   * only in that project. Built-in skills live in code, not here.
   */
  skills: defineTable({
    ownerId: v.string(),
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    description: v.string(),
    body: v.string(),
    source: v.union(v.literal("user"), v.literal("github")),
    sourceUrl: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_owner_and_projectId", ["ownerId", "projectId"])
    .index("by_owner_and_name", ["ownerId", "name"])
    .index("by_project", ["projectId"]),

  /**
   * Whether a skill is enabled in a project. An absent row means disabled;
   * project skills get an enabled row when they are created.
   */
  projectSkillSettings: defineTable({
    projectId: v.id("projects"),
    ownerId: v.string(),
    // "builtin:<name>" | "user:<skills _id>"
    skillKey: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_skillKey", ["projectId", "skillKey"])
    .index("by_owner_and_skillKey", ["ownerId", "skillKey"]),

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

    // Short lease used to serialize refresh-token rotation across concurrent
    // agent runs. Both fields are optional so existing rows migrate safely.
    refreshLeaseId: v.optional(v.string()),
    refreshLeaseExpiresAt: v.optional(v.number()),

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
   * A model provider API key the user brought (BYOK). Sealed exactly like
   * `userConnections`: the AAD is anchored on `secretRef`, and the client only
   * ever sees `maskedPreview` through the allowlist in `aiProviders.list`.
   */
  aiProviderKeys: defineTable({
    userId: v.string(),
    provider: aiProviderValidator,
    label: v.string(),
    // Custom (OpenAI-compatible) endpoints only. Validated https + public IP.
    baseUrl: v.optional(v.string()),
    // Custom only: user-entered model ids, at most MAX_CUSTOM_MODEL_IDS.
    modelIds: v.optional(v.array(v.string())),

    secretRef: v.string(),
    kekProvider: v.string(),
    kekKeyId: v.string(),
    wrappedDek: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    authTag: v.string(),

    // Last four characters only, e.g. "••••3f2a".
    maskedPreview: v.string(),
    status: v.union(v.literal("active"), v.literal("invalid")),
    statusMessage: v.optional(v.string()),
    lastTestedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_provider", ["userId", "provider"]),

  /** The user's default model. No `defaultKeyId` means the Codenaya platform key. */
  userAiPreferences: defineTable({
    userId: v.string(),
    defaultKeyId: v.optional(v.id("aiProviderKeys")),
    defaultModelId: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

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
    // When OAuth starts inside a project, the resulting connection is linked to
    // that project in the same transaction that stores the sealed credential.
    projectId: v.optional(v.id("projects")),
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
    .index("by_expiresAt", ["expiresAt"])
    .index("by_user", ["userId"]),

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
    /**
     * Identity of the logical MCP tool call this row belongs to.
     *
     * Two jobs. It is the idempotency key for creation, so a replayed agent turn
     * reuses this prompt instead of opening another one for the same action. And
     * it is the join key to the audit row, the workflow step ids and the `[mcp]`
     * log lines, which is what makes one logical call traceable end to end.
     *
     * Optional because rows created before this field existed do not have one.
     */
    mcpInvocationId: v.optional(v.string()),
    /**
     * When the approved action was claimed by the executing step.
     *
     * Set exactly once, atomically. A destructive tool takes this claim as the
     * first act inside its step, so a step that re-runs after its result was lost
     * finds the claim already taken and refuses rather than reapplying the
     * mutation. Absence on an approved row means the action has not been issued.
     */
    consumedAt: v.optional(v.number()),
  })
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_message", ["messageId"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_invocation", ["mcpInvocationId"]),

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
    /** Digest of the redaction outcome: how many spans were removed, and by which rules. */
    redactionSummary: v.optional(v.string()),
    durationMs: v.number(),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    /**
     * The logical MCP tool call this row describes.
     *
     * One real request produces exactly one row with a given value here, so a
     * repeated value means a genuinely repeated request rather than a replayed
     * log write. That distinction was previously impossible to make from this
     * table.
     */
    mcpInvocationId: v.optional(v.string()),
  })
    .index("by_project_and_createdAt", ["projectId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_invocation", ["mcpInvocationId"]),
});
