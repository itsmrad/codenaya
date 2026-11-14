/**
 * Curated registry of hosted MCP providers.
 *
 * ## Why a catalog at all
 *
 * Users *can* register an arbitrary MCP server URL, but that path is guarded
 * (see `server/url-guard.ts`) and gives us no idea what the tools do. The
 * catalog is the opposite: a small set of providers whose endpoints, auth
 * modes, scoping parameters and destructive tools we have verified against
 * official documentation, so the UI can offer real read-only and
 * least-privilege choices instead of an all-or-nothing toggle.
 *
 * Everything here is data. The scope-URL builder interprets it; it contains no
 * per-provider branches. Adding a provider means adding an entry below.
 *
 * ## Destructive-tool lists
 *
 * `destructiveTools` feeds the human-in-the-loop approval gate. Being wrong in
 * the permissive direction means an agent silently drops a user's production
 * table, so entries are conservative: anything that writes, migrates, deletes,
 * deploys or can proxy an arbitrary write is listed.
 *
 * ## Deliberately excluded: Vercel MCP (https://mcp.vercel.com)
 *
 * Vercel's hosted MCP server is NOT in this catalog, and its absence is a
 * decision rather than an oversight. Vercel's documentation restricts the
 * server to an allowlist of Vercel-approved AI clients; Codenia is not on that
 * allowlist. Shipping it would mean either connections that fail for opaque
 * reasons or misrepresenting our client identity to get around the
 * restriction. Neither is acceptable.
 *
 * Do not add Vercel here without first re-reading Vercel's current MCP access
 * policy and confirming, in writing, that Codenia is an approved client. If
 * that ever happens, remove this comment block in the same change so it does
 * not become stale advice.
 */

import type {
  ProviderDefinition,
  ProviderScopeCapabilities,
} from "./types";

/** Shared shape for providers that expose no URL-level scoping at all. */
const NO_URL_SCOPING: ProviderScopeCapabilities = {
  queryParams: [],
  headers: [],
};

/**
 * Freeze the registry all the way down.
 *
 * `as const` stops TypeScript-side mutation, but these definitions are handed
 * to request handlers and to the agent runtime, and a stray `push` onto a
 * shared `destructiveTools` array would quietly widen or narrow the approval
 * gate for every tenant. Freezing turns that into an immediate error.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const CATALOG = {
  supabase: {
    id: "supabase",
    displayName: "Supabase",
    mcpUrl: "https://mcp.supabase.com/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.supabase.com"],
    supportsReadOnly: true,
    scope: {
      queryParams: [
        { param: "features", value: { kind: "list", field: "features", encoding: "csv" } },
        { param: "read_only", value: { kind: "flag", field: "readOnly", whenTrue: "true" } },
        { param: "project_ref", value: { kind: "string", field: "projectRef" } },
      ],
      headers: [],
    },
    scopeOptions: {
      features: [
        { id: "docs", enabledByDefault: true },
        { id: "account", enabledByDefault: true },
        { id: "database", enabledByDefault: true },
        { id: "debugging", enabledByDefault: true },
        { id: "development", enabledByDefault: true },
        { id: "functions", enabledByDefault: true },
        { id: "branching", enabledByDefault: true },
        // Storage is the one group Supabase leaves off unless asked for.
        { id: "storage", enabledByDefault: false },
      ],
    },
    destructiveTools: [
      "execute_sql",
      "apply_migration",
      "delete_branch",
      "merge_branch",
      "reset_branch",
      "pause_project",
      "restore_project",
      "deploy_edge_function",
      "update_storage_config",
    ],
  },

  neon: {
    id: "neon",
    displayName: "Neon",
    mcpUrl: "https://mcp.neon.tech/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.neon.tech"],
    supportsReadOnly: true,
    scope: {
      queryParams: [
        // `category` is the only repeatable key in the whole catalog: Neon
        // expects one occurrence per category, not a comma-joined value.
        { param: "category", value: { kind: "list", field: "categories", encoding: "repeat" } },
        { param: "readonly", value: { kind: "flag", field: "readOnly", whenTrue: "true" } },
        { param: "projectId", value: { kind: "string", field: "projectRef" } },
      ],
      headers: [],
    },
    scopeOptions: {
      categories: [
        { id: "projects", enabledByDefault: true },
        { id: "branches", enabledByDefault: true },
        { id: "endpoints", enabledByDefault: true },
        { id: "snapshots", enabledByDefault: true },
        { id: "schema", enabledByDefault: true },
        { id: "querying", enabledByDefault: true },
        { id: "neon_auth", enabledByDefault: true },
        { id: "data_api", enabledByDefault: true },
        { id: "observability", enabledByDefault: true },
        { id: "docs", enabledByDefault: true },
        { id: "functions", enabledByDefault: true },
        { id: "storage", enabledByDefault: true },
      ],
    },
    destructiveTools: [
      "run_sql",
      "run_sql_transaction",
      "prepare_database_migration",
      "complete_database_migration",
      "delete_branch",
      "delete_project",
      "reset_from_parent",
      "provision_neon_auth",
    ],
  },

  github: {
    id: "github",
    displayName: "GitHub",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["api.githubcopilot.com"],
    supportsReadOnly: true,
    scope: {
      // GitHub is the only provider that scopes via headers rather than the
      // URL, which is why the builder returns headers alongside the URL.
      queryParams: [],
      headers: [
        { header: "X-MCP-Toolsets", value: { kind: "list", field: "toolsets", encoding: "csv" } },
        { header: "X-MCP-Readonly", value: { kind: "flag", field: "readOnly", whenTrue: "true" } },
      ],
    },
    destructiveTools: [
      "create_or_update_file",
      "delete_file",
      "create_pull_request",
      "merge_pull_request",
      "create_repository",
      "delete_repository",
      "push_files",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "GitHub personal access token",
    },
  },

  stripe: {
    id: "stripe",
    displayName: "Stripe",
    mcpUrl: "https://mcp.stripe.com",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.stripe.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: ["stripe_api_write", "create_refund"],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Restricted key (rk_...)",
    },
    notes:
      "No URL-level read-only mode. Least privilege comes from the restricted key's own permissions, so prefer a read-scoped rk_ key.",
  },

  context7: {
    id: "context7",
    displayName: "Context7",
    mcpUrl: "https://mcp.context7.com/mcp",
    authModes: ["api_key"],
    trustedHostnames: ["mcp.context7.com"],
    // Read-only by nature: the service only serves library documentation.
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: [],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Context7 API key",
    },
    notes:
      "Documentation lookup only; there is nothing here to mutate. Note that " +
      "this server also answers unauthenticated requests (rate-limited), so a " +
      "successful connection probe does not prove the API key is valid — it " +
      "only proves the server is reachable. Verified against the live endpoint.",
  },

  prisma: {
    id: "prisma",
    displayName: "Prisma Postgres",
    mcpUrl: "https://mcp.prisma.io/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.prisma.io"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: [
      "create_prisma_postgres_database",
      "delete_prisma_postgres_database",
      "execute_sql_query",
      "execute_prisma_postgres_schema_update",
      "delete_prisma_postgres_connection_string",
      "delete_object_store_bucket",
      "delete_object_store_bucket_key",
    ],
  },

  sentry: {
    id: "sentry",
    displayName: "Sentry",
    mcpUrl: "https://mcp.sentry.dev/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.sentry.dev"],
    supportsReadOnly: false,
    scope: {
      queryParams: [
        { param: "experimental", value: { kind: "flag", field: "experimental", whenTrue: "1" } },
      ],
      headers: [],
      // Sentry narrows scope through the path: /mcp/{org} or /mcp/{org}/{project}.
      path: { kind: "segments", segments: ["orgSlug", "projectSlug"] },
    },
    destructiveTools: ["update_issue", "create_project", "update_project_settings"],
  },

  cloudflare: {
    id: "cloudflare",
    displayName: "Cloudflare",
    mcpUrl: "https://mcp.cloudflare.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.cloudflare.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // `execute` is a search-and-execute Code Mode entry point: it can call any
    // Cloudflare API, so it has to be treated as destructive even though its
    // name says nothing about mutation.
    destructiveTools: ["execute"],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Cloudflare API token",
    },
    notes:
      "Code Mode server: the single `execute` tool can perform any Cloudflare API mutation, so every call goes through the approval gate.",
  },

  linear: {
    id: "linear",
    displayName: "Linear",
    mcpUrl: "https://mcp.linear.app/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.linear.app"],
    supportsReadOnly: true,
    scope: {
      queryParams: [],
      headers: [],
      // Linear has no read-only flag; read-only is a separate endpoint.
      path: { kind: "readonly-path", readOnlyUrl: "https://mcp.linear.app/mcp/readonly" },
    },
    destructiveTools: [
      "create_issue",
      "update_issue",
      "create_project",
      "update_project",
      "create_comment",
      "create_document",
    ],
  },

  // Endpoint, auth and scoping: https://posthog.com/docs/model-context-protocol/faq
  // Tool names: https://posthog.com/docs/model-context-protocol/tools
  posthog: {
    id: "posthog",
    displayName: "PostHog",
    mcpUrl: "https://mcp.posthog.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.posthog.com"],
    supportsReadOnly: true,
    scope: {
      queryParams: [
        { param: "features", value: { kind: "list", field: "features", encoding: "csv" } },
        { param: "project_id", value: { kind: "string", field: "projectRef" } },
      ],
      headers: [
        { header: "x-posthog-read-only", value: { kind: "flag", field: "readOnly", whenTrue: "true" } },
      ],
    },
    destructiveTools: [
      "exec", // CLI mode can dispatch writes as well as reads.
      "action-create", "action-update", "action-delete",
      "dashboard-create", "dashboard-update", "dashboard-delete",
      "survey-create", "survey-update", "survey-delete",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "PostHog personal API key (MCP Server preset)",
    },
    notes:
      "Read-only is enforced by the x-posthog-read-only header. Feature groups and project_id narrow the session; the personal API key's MCP Server preset also limits project access.",
  },

  // https://resend.com/docs/mcp-server; exact tool names: resend/resend-mcp src/tools.
  resend: {
    id: "resend",
    displayName: "Resend",
    mcpUrl: "https://mcp.resend.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.resend.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: [
      "send-email", "send-batch-emails", "cancel-email", "update-email", "share-email",
      "create-broadcast", "send-broadcast", "cancel-broadcast", "duplicate-broadcast",
      "remove-broadcast", "compose-broadcast", "update-broadcast",
      "send-new-inbox-email", "send-inbox-draft", "reply-to-inbox-thread-email",
      "forward-inbox-thread-email",
      "create-domain", "update-domain", "remove-domain", "verify-domain",
      "create-domain-claim", "verify-domain-claim",
      "create-template", "compose-template", "update-template", "remove-template",
      "publish-template", "duplicate-template",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Resend API key (re_...)",
    },
    notes:
      "No URL-level scoping or read-only mode. Sending tools deliver real email; use limited API key or OAuth permissions and review write approvals.",
  },

  // https://upstash.com/docs/agent-resources/mcp
  upstash: {
    id: "upstash",
    displayName: "Upstash",
    mcpUrl: "https://mcp.upstash.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.upstash.com"],
    supportsReadOnly: false,
    scope: {
      queryParams: [
        { param: "features", value: { kind: "list", field: "features", encoding: "csv" } },
      ],
      headers: [],
    },
    destructiveTools: [
      "redis_create_database", "redis_create_branch", "redis_create_backup",
      "redis_set_daily_backup", "redis_rename_database", "redis_set_eviction",
      "redis_set_auto_upgrade", "redis_change_plan", "redis_set_prod_pack",
      "redis_set_budget", "redis_update_read_regions", "redis_reset_credentials",
      "redis_delete_database", "redis_run_command",
      "qstash_publish_message", "qstash_flow_control_manage", "qstash_manage_schedule",
      "workflow_manage_run", "dlq_manage", "qstash_set_plan", "qstash_set_prod_pack",
      "qstash_set_budget", "qstash_reset_token",
      "index_create", "index_set_plan", "index_reset_credentials", "index_update",
      "index_rename_namespace", "index_delete", "index_delete_documents",
      "index_reset", "index_delete_namespace", "vector_upsert", "search_upsert",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Upstash developer API key in email:API_KEY format",
    },
    notes:
      "Select features explicitly (redis, qstash_workflow, vector_search) to narrow the tools. Omitting features uses broader vendor defaults, including other product groups. No URL-level read-only enforcement: choose read-only at OAuth consent or use a read-only developer key. Redis commands, QStash publishing and plan changes can write data or incur spend.",
  },

  // Endpoint, auth and exact tool names: https://www.sanity.io/docs/ai/mcp-server
  sanity: {
    id: "sanity",
    displayName: "Sanity",
    mcpUrl: "https://mcp.sanity.io",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.sanity.io"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: [
      "deploy_schema", "undeploy_schema", "schema_types_delete", "schema_fields_patch",
      "deploy_studio", "create_documents", "create_version", "patch_documents",
      "publish_documents", "unpublish_documents", "discard_drafts", "version_discard",
      "create_project", "add_cors_origin", "cors_origins_delete",
      "create_dataset", "update_dataset", "create_release",
      "dataset_assets_upload_from_web_chatgpt", "dataset_assets_upload_from_url",
      "dataset_assets_upload_from_file", "media_library_upload_from_url",
      "media_library_upload_from_file", "media_library_create_documents",
      "media_library_patch_documents", "media_library_publish_documents",
      "media_library_discard_drafts", "media_library_link_assets",
      "generate_image", "transform_image", "run_sanity_cli",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Sanity API token",
    },
    notes:
      "No URL-level project scoping or read-only mode. Token roles or OAuth permissions determine access. Publishing, schema or Studio deployment, and CORS changes write to your project and require review.",
  },

  // https://planetscale.com/docs/mcp-server
  planetscale: {
    id: "planetscale",
    displayName: "PlanetScale",
    mcpUrl: "https://mcp.pscale.dev/mcp/planetscale",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.pscale.dev"],
    trustedAuthorizationServerOrigins: ["https://api.planetscale.com"],
    supportsReadOnly: true,
    scope: {
      queryParams: [],
      headers: [],
      path: {
        kind: "readonly-path",
        readOnlyUrl: "https://mcp.pscale.dev/mcp/planetscale-insights-only",
      },
    },
    destructiveTools: ["planetscale_execute_write_query", "planetscale_update_payment_method"],
    notes:
      "Read-only selects the Insights-only endpoint, excluding both read and write query execution. Other permissions, including billing, remain controlled by OAuth consent and write approvals. No URL-level database scoping. Postgres IP restrictions must allow the MCP server's documented egress IPs.",
  },
} as const satisfies Record<string, ProviderDefinition>;

/** Catalog provider identifiers, derived from the registry itself. */
export type ProviderId = keyof typeof CATALOG;

/**
 * Accepts any string but still autocompletes the known ids.
 *
 * Lookups are fed by persisted documents and by tool calls, so they arrive as
 * plain strings; narrowing the parameter to `ProviderId` would just push casts
 * out to every caller.
 */
export type ProviderIdInput = ProviderId | (string & Record<never, never>);

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDefinition>> =
  deepFreeze(CATALOG);

/** Stable, declaration-ordered list of provider ids. */
const PROVIDER_IDS = Object.freeze(Object.keys(CATALOG) as ProviderId[]);

/** Look up a provider, or `undefined` for an unknown id. */
export function getProvider(
  id: ProviderIdInput,
): ProviderDefinition | undefined {
  // Own-property check keeps prototype keys such as "constructor" from
  // resolving to something that is not a provider.
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id)
    ? PROVIDERS[id as ProviderId]
    : undefined;
}

/** Every catalog provider, in declaration order. */
export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}

/**
 * Whether a tool must pass the approval gate.
 *
 * Unknown providers and unknown tools return `false`: this function answers
 * "is this on the known-destructive list", and the gate for unknown servers is
 * a separate policy decision rather than something to conflate here.
 */
export function isDestructiveTool(
  providerId: ProviderIdInput,
  toolName: string,
): boolean {
  return getProvider(providerId)?.destructiveTools.includes(toolName) ?? false;
}

/**
 * Every hostname in the catalog, for the SSRF guard's `trustedHosts` option.
 *
 * Sorted and de-duplicated so the allowlist is stable across calls.
 */
export function getTrustedHostnames(): readonly string[] {
  const hostnames = new Set<string>();
  for (const id of PROVIDER_IDS) {
    for (const hostname of PROVIDERS[id].trustedHostnames) {
      hostnames.add(hostname);
    }
  }
  return [...hostnames].sort();
}
