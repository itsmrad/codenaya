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
    notes: "Documentation lookup only; there is nothing here to mutate.",
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
