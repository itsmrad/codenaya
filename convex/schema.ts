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
  v.literal("groq"),
  v.literal("custom"),
);

/** Providers the Codenaya platform key can run on (`NEXT_PUBLIC_AI_PROVIDER`). */
export const platformProviderValidator = v.union(
  v.literal("openrouter"),
  v.literal("openai"),
  v.literal("anthropic"),
  v.literal("groq"),
);

/**
 * A model the admin made available to users on the platform key. `tools` is
 * "reported" when the provider's API said it supports tool calling, and
 * "confirmed" when the API didn't say and the admin vouched for it. Prices are
 * required: an enabled model is never unpriced (USD per 1M tokens).
 */
export const platformModelValidator = v.object({
  id: v.string(),
  name: v.string(),
  vendor: v.string(),
  contextLength: v.optional(v.number()),
  vision: v.boolean(),
  tools: v.union(v.literal("reported"), v.literal("confirmed")),
  inputUsdPerMTok: v.number(),
  outputUsdPerMTok: v.number(),
});

/**
 * A route's price, USD per 1M tokens (ADR 0010). "blended" is one number for
 * input and output alike; "split" prices them apart.
 */
export const modelPricingValidator = v.union(
  v.object({ mode: v.literal("blended"), usdPerMTok: v.number() }),
  v.object({
    mode: v.literal("split"),
    inputUsdPerMTok: v.number(),
    outputUsdPerMTok: v.number(),
  }),
);

/**
 * Who may pick a catalog model: everyone, or GitHub promo claimants only
 * (ADR 0009). "promo_counted" runs use the claim's counted runs.
 */
export const modelAccessValidator = v.union(
  v.literal("everyone"),
  v.literal("promo_counted"),
  v.literal("promo_unlimited"),
);

/**
 * One model of the platform catalog and the provider route that serves it
 * (ADR 0010). `id` is stable across provider switches: users pick it,
 * preferences and messages record it. `providerModelId` is what the provider's
 * API is called with. `tools` as in `platformModelValidator`. A `hidden` model
 * keeps its route and price but isn't offered to users.
 */
export const catalogModelValidator = v.object({
  id: v.string(),
  name: v.string(),
  vendor: v.string(),
  provider: platformProviderValidator,
  providerModelId: v.string(),
  contextLength: v.optional(v.number()),
  vision: v.boolean(),
  tools: v.union(v.literal("reported"), v.literal("confirmed")),
  pricing: modelPricingValidator,
  access: modelAccessValidator,
  hidden: v.boolean(),
});

/** A credit account's plan (ADR 0011); see `PLANS` in `features/billing/plans.ts`. */
export const planIdValidator = v.union(v.literal("free"), v.literal("pro"));
/** Who pays for a run (ADR 0011). Only "platform" runs cost credits. */
export const runSourceValidator = v.union(v.literal("platform"), v.literal("promo"), v.literal("byok"));

/**
 * The model an assistant message was produced with. `keyId` is set when the
 * run used the user's own key (BYOK), which is what billing reads to charge no
 * credits. `label` is the "provider · model" shown on the run block.
 */
export const runModelValidator = v.object({
  keyId: v.optional(v.id("aiProviderKeys")),
  modelId: v.string(),
  label: v.string(),
  // Platform runs since ADR 0010: the provider whose key served it.
  provider: v.optional(platformProviderValidator),
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
    // Legacy: text moved to `fileContents` (#412); kept until the backfill has run everywhere.
    content: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")), // Binary files only
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["parentId"])
    .index("by_project_and_parent_and_name", ["projectId", "parentId", "name"])
    .index("by_storageId", ["storageId"]),

  /**
   * A text file's content, kept out of `files` so listing a project reads only
   * metadata (#412). One row per text file; see `convex/fileContents.ts`.
   */
  fileContents: defineTable({
    fileId: v.id("files"),
    // Lets project-wide reads and cascades use one index range.
    projectId: v.id("projects"),
    content: v.string(),
  })
    .index("by_file", ["fileId"])
    .index("by_project", ["projectId"]),

  /**
   * The project's files just before an agent run (#43), restorable from the
   * chat. One row per run, keyed by its assistant message; see
   * `convex/checkpoints.ts`.
   */
  checkpoints: defineTable({
    projectId: v.id("projects"),
    messageId: v.id("messages"),
    // The prompt that started the run, for the history list.
    label: v.string(),
    fileCount: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_message", ["messageId"]),

  /** One file or folder of a checkpoint. Binary files keep their blob. */
  checkpointFiles: defineTable({
    checkpointId: v.id("checkpoints"),
    projectId: v.id("projects"),
    path: v.string(),
    type: v.union(v.literal("file"), v.literal("folder")),
    content: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_checkpoint", ["checkpointId"])
    .index("by_project", ["projectId"])
    .index("by_storageId", ["storageId"]),

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
    // Legacy: the Vercel Workflow run id, set by the retired Workflow backend
    // (ADR 0005). Kept because existing rows have it; nothing writes it now.
    workflowRunId: v.optional(v.string()),
    // Agent activity for the chat panel. Bounded: see MAX_MESSAGE_STEPS.
    steps: v.optional(v.array(messageStepValidator)),
    // When the run stopped (completed or cancelled), for "Worked for Xs".
    completedAt: v.optional(v.number()),
    // Assistant messages only: the model the run used.
    runModel: v.optional(runModelValidator),
    // User messages only: attached images. Bounded: see MAX_CHAT_IMAGES.
    images: v.optional(v.array(v.id("_storage"))),
    // Assistant messages only: a plan-mode reply, which wrote no files (#120).
    mode: v.optional(v.literal("plan")),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_project_status", ["projectId", "status"])
    // For the lost-run sweep in maintenance.ts.
    .index("by_status", ["status"]),

  // Images uploaded from the chat composer: who uploaded each blob, so a
  // message can only attach its sender's own images. Deleted with the project.
  chatImages: defineTable({
    storageId: v.id("_storage"),
    projectId: v.id("projects"),
    ownerId: v.string(),
  })
    .index("by_storageId", ["storageId"])
    .index("by_projectId", ["projectId"]),

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
    /**
     * "unlisted" entries exist for their owner but stay off every public
     * list and page, e.g. ones published by test accounts.
     */
    status: v.union(
      v.literal("published"),
      v.literal("unlisted"),
      v.literal("removed"),
    ),
    /** Picked for the landing page strip; set with `showcase.setFeatured`. */
    featured: v.optional(v.boolean()),
    publishedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_and_publishedAt", ["status", "publishedAt"])
    .index("by_status_and_featured_and_publishedAt", ["status", "featured", "publishedAt"])
    .index("by_status_and_upvotes", ["status", "upvotes"])
    .index("by_status_and_importCount", ["status", "importCount"])
    .index("by_owner", ["ownerId"])
    .index("by_projectId_and_status", ["projectId", "status"])
    .index("by_previewImageId", ["previewImageId"])
    .index("by_status_and_category_and_publishedAt", ["status", "category", "publishedAt"])
    .index("by_status_and_category_and_upvotes", ["status", "category", "upvotes"])
    .index("by_status_and_category_and_importCount", ["status", "category", "importCount"])
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

  showcaseImports: defineTable({
    showcaseProjectId: v.id("showcaseProjects"),
    userId: v.string(),
    importedAt: v.number(),
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
    .index("by_owner_and_skillKey_and_enabled", ["ownerId", "skillKey", "enabled"]),

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

  /**
   * A claim of the GitHub launch promotion (ADR 0009). One per user, and one
   * per GitHub account, so a GitHub account linked to several Codenaya users
   * claims only once. The counter lives here: only its owner's sends touch it.
   */
  promoClaims: defineTable({
    userId: v.string(),
    githubUserId: v.number(),
    githubLogin: v.string(),
    githubCreatedAt: v.number(),
    opusRunsUsed: v.number(),
    claimedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_githubUserId", ["githubUserId"]),

  /**
   * A user's credit usage this month and today (ADR 0011). Created on the first
   * metered run; none means nothing used. Periods reset lazily on the next read
   * or charge (`currentUsage` in `features/billing/credits.ts`).
   */
  creditAccounts: defineTable({
    userId: v.string(),
    plan: planIdValidator,
    periodStartsAt: v.number(),
    periodUsed: v.number(),
    dayStartsAt: v.number(),
    dayUsed: v.number(),
  }).index("by_userId", ["userId"]),

  /**
   * One row per agent run: its running token and cost totals and the credits
   * charged so far. Every run is recorded, BYOK and promo runs at 0 credits.
   * Charges set totals rather than add to them, so a retried step is a no-op.
   */
  creditLedger: defineTable({
    userId: v.string(),
    messageId: v.id("messages"),
    source: runSourceValidator,
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
    credits: v.number(),
    updatedAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_userId", ["userId"]),

  /** The user's default model. No `defaultKeyId` means the Codenaya platform key. */
  userAiPreferences: defineTable({
    userId: v.string(),
    defaultKeyId: v.optional(v.id("aiProviderKeys")),
    defaultModelId: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * The platform model catalog (ADR 0010): every model users may run on
   * Codenaya's keys, each with its own provider route and price. A single
   * bounded doc (at most MAX_PLATFORM_MODELS models), read once per send. None
   * means the env provider's curated catalog (`NEXT_PUBLIC_AI_PROVIDER`).
   * `utilityModelId` serves chat titles and editor AI.
   */
  platformCatalog: defineTable({
    models: v.array(catalogModelValidator),
    defaultModelId: v.string(),
    utilityModelId: v.string(),
    updatedAt: v.number(),
    // identity.subject of the admin who saved it.
    updatedBy: v.string(),
  }),

  /** Deprecated by `platformCatalog` (ADR 0010); kept until migrated, then dropped. */
  platformModelConfigs: defineTable({
    provider: platformProviderValidator,
    models: v.array(platformModelValidator),
    defaultModelId: v.string(),
    updatedAt: v.number(),
    // identity.subject of the admin who saved it.
    updatedBy: v.string(),
  }).index("by_provider", ["provider"]),

  /** Deprecated by `platformCatalog` (ADR 0010); kept until migrated, then dropped. */
  platformSettings: defineTable({
    activeProvider: platformProviderValidator,
    updatedAt: v.number(),
    updatedBy: v.string(),
  }),

  /** Every admin change, written in the same transaction as the change. */
  adminAuditLog: defineTable({
    actorId: v.string(),
    actorEmail: v.string(),
    action: v.string(),
    summary: v.string(),
    at: v.number(),
    // Structured before/after per changed field (ADR 0010); older rows have none.
    changes: v.optional(
      v.array(
        v.object({
          field: v.string(),
          before: v.optional(v.string()),
          after: v.optional(v.string()),
        }),
      ),
    ),
    // The admin request that made the change, from the Next route.
    requestId: v.optional(v.string()),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  }).index("by_at", ["at"]),

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
   * The agent polls its own row from inside a durable step, rather than waiting
   * on a backend-specific signal.
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
