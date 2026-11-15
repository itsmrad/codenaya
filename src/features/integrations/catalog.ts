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

import { POSTHOG_DESTRUCTIVE_TOOLS } from "./posthog-destructive-tools";
import { POSTHOG_READ_TOOLS } from "./posthog-read-tools";

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
    description: "Query tables and run database migrations.",
    category: "Database",
    logo: "/integrations/supabase.svg",
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
    // Reads annotated read-only in supabase-community/supabase-mcp src/tools.
    readOnlyTools: [
      "generate_typescript_types", "get_advisors", "get_cost", "get_edge_function", "get_logs",
      "get_notebook", "get_organization", "get_project", "get_project_url",
      "get_storage_config", "list_branches", "list_edge_functions",
      "list_extensions", "list_migrations", "list_notebooks", "list_organizations",
      "list_projects", "list_storage_buckets", "list_tables", "query_logs", "search_docs",
      // Returns publishable (anon) keys, which are public by design.
      "get_publishable_keys",
    ],
  },

  neon: {
    id: "neon",
    displayName: "Neon",
    description: "Query Postgres and manage database branches.",
    category: "Database",
    logo: "/integrations/neon.svg",
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
    // Reads from the neondatabase/mcp-server-neon README tool list; generated Management API tools stay gated.
    readOnlyTools: [
      "compare_database_schema", "count_projects", "describe_branch", "describe_project",
      "describe_table_schema", "fetch", "get_branch_consumption", "get_database_tables",
      "get_doc", "get_function", "get_neon_auth_config", "get_postgres_endpoint",
      "get_project_consumption", "get_realtime", "get_snapshot_schedule", "get_storage",
      "get_trigger", "inspect_database", "list_auth_oauth_providers",
      "list_auth_trusted_domains", "list_branch_computes", "list_branches", "list_functions",
      "list_functions_custom_domains", "list_incidents", "list_log_field_values",
      "list_log_fields", "list_organizations", "list_postgres_endpoints", "list_projects",
      "list_slow_queries", "list_snapshots", "list_storage_buckets", "list_storage_objects",
      "list_triggers", "query_logs", "query_loki_logs", "search", "search_docs",
      // List output never includes client_secret (zNeonAuthOAuthClient in @neon/tools); only create returns it.
      "list_auth_oauth_clients",
    ],
  },

  github: {
    id: "github",
    displayName: "GitHub",
    description: "Browse repositories, issues and pull requests.",
    category: "Dev tools",
    logo: "/integrations/github.svg",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["api.githubcopilot.com"],
    supportsReadOnly: true,
    scope: {
      // Header scopes leave the URL unchanged; the builder returns both.
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
    // Reads annotated read-only in github/github-mcp-server pkg/github/__toolsnaps__.
    readOnlyTools: [
      "actions_get", "actions_list", "custom_properties_read", "find_duplicate",
      "get_code_quality_finding", "get_code_scanning_alert", "get_commit",
      "get_dependabot_alert", "get_discussion", "get_discussion_comments", "get_file_blame",
      "get_file_contents", "get_gist", "get_global_security_advisory", "get_job_logs",
      "get_label", "get_latest_release", "get_me", "get_notification_details",
      "get_release_by_tag", "get_repository_tree", "get_tag",
      "get_team_members", "get_teams", "issue_artifact_read", "issue_dependency_read",
      "issue_read", "list_branches", "list_code_scanning_alerts", "list_commits",
      "list_dependabot_alerts", "list_discussion_categories", "list_discussions", "list_gists",
      "list_global_security_advisories", "list_issue_fields", "list_issue_types", "list_issues",
      "list_label", "list_notifications", "list_org_repository_security_advisories",
      "list_pull_requests", "list_releases", "list_repository_collaborators",
      "list_repository_security_advisories",
      "list_starred_repositories", "list_tags", "projects_get", "projects_list",
      "pull_request_read", "repository_ruleset_read", "search_code", "search_commits",
      "search_issues", "search_orgs", "search_pull_requests", "search_repositories",
      "search_users", "ui_get",
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
    description: "Look up customers, payments and subscriptions.",
    category: "Payments",
    logo: "/integrations/stripe.svg",
    mcpUrl: "https://mcp.stripe.com",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.stripe.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: ["stripe_api_write", "create_refund"],
    // Reads from https://docs.stripe.com/mcp#tools. stripe_api_read dispatches any GET method, so it stays gated.
    readOnlyTools: [
      "get_balance_summary", "get_stripe_account_info", "search_stripe_documentation",
      "stripe_api_details", "stripe_api_search",
    ],
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
    description: "Look up current library docs and code examples.",
    category: "Docs",
    logo: "/integrations/context7.svg",
    mcpUrl: "https://mcp.context7.com/mcp",
    authModes: ["api_key"],
    trustedHostnames: ["mcp.context7.com"],
    // Read-only by nature: the service only serves library documentation.
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: [],
    // Both tools from the upstash/context7 README; documentation lookup only.
    readOnlyTools: [
      "query-docs", "resolve-library-id",
    ],
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
    description: "Query Postgres and update database schemas.",
    category: "Database",
    logo: "/integrations/prisma.svg",
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
    // Reads from https://www.prisma.io/docs/ai/mcp-tools.
    readOnlyTools: [
      "fetch_workspace_details", "get_prisma_composer_topology",
      "get_prisma_compute_deployment_logs", "introspect_database_schema",
      "list_object_store_buckets", "list_prisma_compute_apps", "list_prisma_compute_builds",
      "list_prisma_compute_deployments", "list_prisma_postgres_backups",
      "list_prisma_postgres_databases", "search_prisma_documentation",
    ],
  },

  sentry: {
    id: "sentry",
    displayName: "Sentry",
    description: "Investigate errors, issues and stack traces.",
    category: "Monitoring",
    logo: "/integrations/sentry.svg",
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
    // Reads from getsentry/sentry-mcp packages/mcp-core/src/toolDefinitions.json.
    readOnlyTools: [
      "find_alert_rules", "find_dashboards", "find_dropped_events",
      "find_metric_monitors", "find_monitors", "find_organizations", "find_projects",
      "find_releases", "find_teams", "find_uptime_monitors", "get_agent_conversation_details",
      "get_ai_conversation_details", "get_alert_options", "get_alert_rule",
      "get_dashboard_details", "get_doc", "get_event_attachment", "get_event_stacktrace",
      "get_issue_activity", "get_issue_breadcrumbs", "get_issue_details",
      "get_issue_tag_values", "get_issue_user_reports", "get_latest_base_snapshot",
      "get_metric_monitor_details", "get_monitor_details", "get_profile", "get_profile_details",
      "get_release_details", "get_replay_details", "get_sentry_mcp_info", "get_sentry_resource",
      "get_snapshot", "get_snapshot_image", "get_span_details", "get_trace_details",
      "get_uptime_monitor_details", "search_agent_conversations", "search_ai_conversations",
      "search_docs", "search_errors", "search_events", "search_issue_events", "search_issues",
      "search_logs", "search_metrics", "search_profiles", "search_replays", "search_traces",
      "whoami",
      // Returns DSNs, client keys that are public by design.
      "find_dsns",
    ],
  },

  cloudflare: {
    id: "cloudflare",
    displayName: "Cloudflare",
    description: "Manage Workers, storage and cloud resources.",
    category: "Dev tools",
    logo: "/integrations/cloudflare.svg",
    mcpUrl: "https://mcp.cloudflare.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.cloudflare.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // `execute` is a search-and-execute Code Mode entry point: it can call any
    // Cloudflare API, so it has to be treated as destructive even though its
    // name says nothing about mutation.
    destructiveTools: ["execute"],
    // From the cloudflare/mcp README. `search` runs agent-written code, so it stays gated.
    readOnlyTools: [
      "docs", "whoami",
    ],
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
    description: "Track issues, projects and team work.",
    category: "Dev tools",
    logo: "/integrations/linear.svg",
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
    description: "Explore product analytics, feature flags, experiments, and dashboards.",
    category: "Analytics",
    logo: "/integrations/posthog.svg",
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
    destructiveTools: POSTHOG_DESTRUCTIVE_TOOLS,
    readOnlyTools: POSTHOG_READ_TOOLS,
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
    description: "Send email and manage domains, contacts, and broadcasts.",
    category: "Communication",
    logo: "/integrations/resend.svg",
    mcpUrl: "https://mcp.resend.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.resend.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    destructiveTools: [
      "add-contact-to-segment", "add-inbox-thread-labels", "add-suppression",
      "batch-add-suppressions", "batch-remove-suppressions", "cancel-broadcast",
      "cancel-email", "compose-broadcast", "compose-template",
      "connect-to-editor", "create-api-key", "create-automation",
      "create-broadcast", "create-contact", "create-contact-import",
      "create-contact-property", "create-domain", "create-domain-claim",
      "create-inbox", "create-inbox-draft", "create-inbox-label",
      "create-segment", "create-template", "create-topic",
      "create-webhook", "disconnect-from-editor", "duplicate-automation",
      "duplicate-broadcast", "duplicate-template", "forward-inbox-thread-email",
      "manage-events", "publish-template", "remove-api-key",
      "remove-automation", "remove-broadcast", "remove-contact",
      "remove-contact-from-segment", "remove-contact-property", "remove-domain",
      "remove-inbox", "remove-inbox-draft", "remove-inbox-label",
      "remove-inbox-thread", "remove-inbox-thread-label", "remove-segment",
      "remove-suppression", "remove-template", "remove-topic",
      "remove-webhook", "replay-webhook-event", "reply-to-inbox-thread-email",
      "revoke-oauth-grant", "rotate-webhook-signing-secret", "send-batch-emails",
      "send-broadcast", "send-email", "send-event",
      "send-inbox-draft", "send-new-inbox-email", "set-inbox-thread-labels",
      "share-email", "update-api-key", "update-automation",
      "update-broadcast", "update-contact", "update-contact-property",
      "update-contact-topics", "update-domain", "update-email",
      "update-inbox", "update-inbox-agent", "update-inbox-draft",
      "update-inbox-label", "update-inbox-thread", "update-segment",
      "update-template", "update-topic", "update-webhook",
      "verify-domain", "verify-domain-claim",
    ],
    // Reads annotated read-only in resend/resend-mcp src/tools, except get-webhook, which returns the signing secret.
    readOnlyTools: [
      "get-automation", "get-automation-runs", "get-broadcast", "get-contact",
      "get-contact-import", "get-contact-property", "get-domain", "get-domain-claim",
      "get-email", "get-email-metrics", "get-inbox", "get-inbox-agent", "get-inbox-draft",
      "get-inbox-thread", "get-inbox-thread-email", "get-log", "get-received-email",
      "get-received-email-attachment", "get-segment", "get-sent-email-attachment",
      "get-suppression", "get-template", "get-tiptap-json-content", "get-topic", "get-usage",
      "get-webhook-event", "list-api-keys", "list-broadcast-clicked-links",
      "list-broadcast-recipients", "list-broadcasts", "list-contact-imports",
      "list-contact-properties", "list-contact-segments", "list-contact-topics",
      "list-contacts", "list-domains", "list-emails", "list-inbox-drafts", "list-inbox-labels",
      "list-inbox-thread-emails", "list-inbox-threads", "list-inboxes", "list-logs",
      "list-oauth-grants", "list-received-email-attachments", "list-received-emails",
      "list-segments", "list-sent-email-attachments", "list-suppressions", "list-templates",
      "list-topics", "list-webhook-event-attempts", "list-webhook-events", "list-webhooks",
      "search-inbox-threads",
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
    description: "Manage Redis, QStash workflows, and Vector or Search resources.",
    category: "Database",
    logo: "/integrations/upstash.svg",
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
      "blob_bucket", "blob_object", "blob_upload_url",
      "box_apikey", "box_browser", "box_config",
      "box_env", "box_exec", "box_git",
      "box_manage", "box_preview", "box_runs",
      "box_schedules", "box_snapshots", "dlq_manage",
      "index_create", "index_delete", "index_delete_documents",
      "index_delete_namespace", "index_rename_namespace", "index_reset",
      "index_reset_credentials", "index_set_plan", "index_update",
      "qstash_flow_control_manage", "qstash_manage_schedule", "qstash_publish_message",
      "qstash_reset_token", "qstash_set_budget", "qstash_set_plan",
      "qstash_set_prod_pack", "redis_change_plan", "redis_create_backup",
      "redis_create_branch", "redis_create_database", "redis_delete_database",
      "redis_rename_database", "redis_reset_credentials", "redis_run_command",
      "redis_set_auto_upgrade", "redis_set_budget", "redis_set_daily_backup",
      "redis_set_eviction", "redis_set_prod_pack", "redis_update_read_regions",
      "search_upsert", "submit_feedback_to_upstash_team", "vector_upsert",
      "workflow_manage_run",
    ],
    // Tools marked read at https://upstash.com/docs/agent-resources/mcp, except those that can return credentials.
    readOnlyTools: [
      "blob_download_url", "box_account", "box_logs", "box_metrics", "console_redis_keys",
      "console_redis_value", "dlq_list", "index_fetch", "index_get_stats", "index_info",
      "index_list", "index_list_namespaces", "index_range", "logs_list",
      "qstash_flow_control_get", "qstash_get_stats", "qstash_list_schedules",
      "redis_get_insights", "redis_get_stats", "redis_get_traffic", "redis_list_backups",
      "redis_list_databases", "search_query", "vector_query",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Upstash developer API key in email:API_KEY format",
    },
    notes:
      "Select features explicitly (redis, qstash_workflow, vector_search) to narrow the tools. An explicit selection excludes omitted groups; leaving features out enables all six vendor groups. No URL-level read-only enforcement: choose read-only at OAuth consent or use a read-only developer key. Redis commands, QStash publishing and plan changes can write data or incur spend.",
  },

  // Endpoint, auth and exact tool names: https://www.sanity.io/docs/ai/mcp-server
  sanity: {
    id: "sanity",
    displayName: "Sanity",
    description: "Query and edit content, manage releases, and configure projects.",
    category: "Content",
    logo: "/integrations/sanity.svg",
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
    // Reads from https://www.sanity.io/docs/ai/mcp-server.
    readOnlyTools: [
      "assets_upload_status", "cors_origins_list", "documents_validate", "get_document",
      "get_project_studios", "get_sanity_rules", "get_schema", "list_datasets",
      "list_embeddings_indices", "list_organizations", "list_projects", "list_releases",
      "list_sanity_rules", "list_workspace_schemas", "media_library_get_document",
      "media_library_get_schema", "media_library_list", "media_library_list_asset_references",
      "media_library_query_documents", "query_documents", "read_docs", "schema_type_get",
      "search_docs", "semantic_search", "usage_history_get", "usage_snapshot_get",
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
    description: "Inspect database schema and Insights, and run permitted queries.",
    category: "Database",
    logo: "/integrations/planetscale.svg",
    mcpUrl: "https://mcp.pscale.dev/mcp/planetscale",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.pscale.dev"],
    trustedAuthorizationServerOrigins: ["https://api.planetscale.com"],
    // The Insights-only path still permits separately authorized billing writes.
    supportsReadOnly: false,
    scope: {
      queryParams: [],
      headers: [],
      path: {
        kind: "readonly-path",
        readOnlyUrl: "https://mcp.pscale.dev/mcp/planetscale-insights-only",
      },
    },
    destructiveTools: ["planetscale_execute_write_query", "planetscale_update_payment_method"],
    // Reads from https://planetscale.com/docs/mcp-server. planetscale_execute_read_query runs SQL, so it stays gated.
    readOnlyTools: [
      "planetscale_get_branch", "planetscale_get_branch_metrics",
      "planetscale_get_branch_schema", "planetscale_get_database", "planetscale_get_insights",
      "planetscale_get_invoice_line_items", "planetscale_get_organization",
      "planetscale_get_organization_billing_payment_method",
      "planetscale_get_payment_method_setup", "planetscale_get_postgres_logs",
      "planetscale_get_query_tag", "planetscale_list_branches",
      "planetscale_list_cluster_size_skus", "planetscale_list_databases",
      "planetscale_list_invoices", "planetscale_list_organizations",
      "planetscale_list_query_error_executions", "planetscale_list_query_error_patterns",
      "planetscale_list_query_tag_summaries", "planetscale_list_query_tags",
      "planetscale_list_regions_for_organization", "planetscale_list_schema_recommendations",
      "planetscale_search_documentation",
    ],
    notes:
      "The read-only selection uses the Insights-only endpoint, excluding both read and write query execution. This is not server-enforced read-only: billing writes remain separately authorized by OAuth consent and gated, and unannotated tools still require approval. No URL-level database scoping. Postgres IP restrictions must allow the MCP server's documented egress IPs.",
  },

  notion: {
    id: "notion",
    displayName: "Notion",
    description: "Search and manage Notion pages and databases.",
    category: "Productivity",
    logo: "/integrations/notion.svg",
    mcpUrl: "https://mcp.notion.com/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.notion.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Full published inventory: https://developers.notion.com/guides/mcp/tools-faqs
    destructiveTools: [
      "notion-calendar-cancel-events",
      "notion-calendar-create-events",
      "notion-calendar-update-events",
      "notion-convert-page-to-skill",
      "notion-create-attachment",
      "notion-create-comment",
      "notion-create-database",
      "notion-create-file-upload",
      "notion-create-folder",
      "notion-create-pages",
      "notion-create-suggested-edit",
      "notion-create-view",
      "notion-delete-comment",
      "notion-delete-databases",
      "notion-delete-pages",
      "notion-duplicate-page",
      "notion-move-pages",
      "notion-resolve-suggested-edit",
      "notion-restore-pages",
      "notion-restore-version",
      "notion-send-message-to-session",
      "notion-set-comment-reaction",
      "notion-set-discussion-resolved",
      "notion-spawn-session",
      "notion-stop-session",
      "notion-update-comment",
      "notion-update-data-source",
      "notion-update-enabled-skills",
      "notion-update-folder",
      "notion-update-page",
      "notion-update-view",
      "notion-upload-skill",
    ],
    // Reads from the inventory above.
    readOnlyTools: [
      "notion-ai-search", "notion-calendar-list-calendar-resources",
      "notion-calendar-list-calendars", "notion-calendar-list-contacts",
      "notion-calendar-list-coworkers-events", "notion-calendar-list-events",
      "notion-connector-search", "notion-download-attachment", "notion-download-skill",
      "notion-fetch", "notion-get-async-task", "notion-get-comments",
      "notion-get-enabled-skills", "notion-get-file-download-urls", "notion-get-groups",
      "notion-get-self", "notion-get-session-status", "notion-get-suggested-edit",
      "notion-get-teams", "notion-get-tool-access", "notion-get-users",
      "notion-get-version-changes", "notion-list-favorite-pages", "notion-list-page-backlinks",
      "notion-list-private-pages", "notion-list-recent-pages", "notion-list-session-events",
      "notion-list-shared-pages", "notion-memory-search", "notion-query-data-sources",
      "notion-query-meeting-notes", "notion-query-multiple-data-sources",
      "notion-query-sessions", "notion-read-session-event", "notion-search",
      "notion-search-agents", "notion-search-sessions", "notion-view-version",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Notion MCP token (Business/Enterprise workspace owner)",
    },
    notes:
      "Workspace members only; guests cannot connect. MCP tokens require a Business or Enterprise plan and must be created by a workspace owner. No URL-level read-only mode.",
  },

  atlassian: {
    id: "atlassian",
    displayName: "Atlassian (Jira / Confluence)",
    description: "Search and manage Jira work items and Confluence pages.",
    category: "Productivity",
    logo: "/integrations/atlassian.svg",
    mcpUrl: "https://mcp.atlassian.com/v2/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.atlassian.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Full inventory, including deferred execution: https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/
    destructiveTools: [
      "execute",
      "executeRead",
      "executeWrite",
      "executeDestructive",
      "createJiraIssue",
      "editJiraIssue",
      "transitionJiraIssue",
      "addOrEditJiraIssueComment",
      "addOrEditJiraIssueWorklog",
      "createJiraIssueLink",
      "manageJiraProjectVersion",
      "manageJiraProjectVersionRelatedWork",
      "manageJiraSprint",
      "createJiraBoard",
      "watchJiraIssue",
      "uploadAttachmentToJiraIssue",
      "editJiraEntityProperty",
      "createJiraIssueRemoteIssueLink",
      "convertJiraIssueHierarchy",
      "deleteJiraIssue",
      "deleteJiraComment",
      "deleteJiraIssueAttachment",
      "createJiraProject",
      "updateJiraProject",
      "updateJiraScreen",
      "createConfluenceContent",
      "updateConfluenceContent",
      "createConfluenceSpace",
      "setConfluenceSpaceInstructions",
      "copyConfluenceContent",
      "moveConfluenceContent",
      "archiveConfluenceContent",
      "unarchiveConfluenceContent",
      "restoreConfluenceContentVersion",
      "convertConfluenceContentMode",
      "setConfluenceContentStatus",
      "createConfluenceComment",
      "updateConfluenceComment",
      "updateConfluenceCommentResolution",
      "addConfluenceContentSuggestions",
      "createConfluenceAttachment",
      "addLabelsToConfluenceContent",
      "addConfluenceReaction",
      "addConfluenceContentPermissions",
      "removeConfluenceContentPermissions",
      "replaceConfluenceContentPermissions",
      "setConfluenceContentRestrictionState",
      "enableConfluencePublicLink",
      "disableConfluencePublicLink",
      "completeConfluenceTask",
      "reopenConfluenceTask",
      "starConfluenceContent",
      "unstarConfluenceContent",
      "starConfluenceSpace",
      "unstarConfluenceSpace",
      "watchConfluenceContent",
      "unwatchConfluenceContent",
      "watchConfluenceSpace",
      "unwatchConfluenceSpace",
      "watchConfluenceLabel",
      "unwatchConfluenceLabel",
      "createConfluenceInfographicForPage",
      "editConfluenceInfographicForPage",
      "createConfluenceMauiApp",
      "editConfluenceMauiApp",
      "updateJsmOpsAlert",
      "approveJsmRequestResolverPlans",
      "transitionJsmRequest",
      "createJsmRequest",
      "decideJsmRequestApproval",
      "setJsmAgentAvailability",
      "createBitbucketRepoPullRequest",
      "updateBitbucketRepoPullRequest",
      "mergeBitbucketRepoPullRequest",
      "approveBitbucketRepoPullRequest",
      "requestChangesOnBitbucketRepoPullRequest",
      "addBitbucketRepoPullRequestComment",
      "resolveBitbucketRepoPullRequestComment",
      "reopenBitbucketRepoPullRequestComment",
      "createBitbucketRepoPullRequestTask",
      "setBitbucketRepoPullRequestTaskState",
      "createBitbucketRepoBranch",
      "createBitbucketRepoCommit",
      "runBitbucketRepoPipeline",
      "addTeamworkGraphContext",
      "createLoomObjectUpload",
      "publishLoomObject",
      "updateLoomObjectMetadata",
      "updateLoomObjectVisibility",
      "shareLoomObject",
      "addLoomInteraction",
      "createLoomObjectFolder",
      "moveLoomObjectToFolder",
      "recoverLoomVideo",
      "createGoal",
      "createGoalUpdate",
      "addConnectionsToGoals",
      "createProject",
      "createProjectUpdate",
      "addConnectionsToProjects",
      "createTeam",
      "updateTeam",
      "createFocusArea",
      "updateFocusArea",
      "createFocusAreaStatusUpdate",
      "linkToFocusArea",
      "createTalentSkill",
      "updateTalentWorkerSkillMappings",
      "updateTalentPositionFocusAreaMappings",
      "updateCapacityPlanAllocation",
      "createCapacityPlanNonProjectWork",
      "updateCapacityPlanNonProjectWork",
      "createJiraAlignItem",
      "updateJiraAlignItem",
      "queryInsightsSql",
      "queryInsightsAi",
    ],
    // read_* and search_* groups from the inventory above, minus credit-consuming Enriched tools and exports.
    readOnlyTools: [
      "atlassianUserInfo", "describeJiraAlignItemType", "diffConfluenceContentVersions",
      "discover", "downloadConfluenceAttachment", "downloadJiraIssueAttachment",
      "getAccessibleAtlassianResources", "getAssetsObject", "getAssetsObjectSchema",
      "getAssetsObjectType", "getAssetsObjectsById", "getAssetsServiceObjectsById",
      "getBitbucketRepoBranch", "getBitbucketRepoCommit", "getBitbucketRepoCommitReport",
      "getBitbucketRepoCommitReportAnnotations", "getBitbucketRepoDefaultReviewers",
      "getBitbucketRepoDeployment", "getBitbucketRepoEnvironment",
      "getBitbucketRepoFileContent", "getBitbucketRepoPipeline", "getBitbucketRepoPipelineStep",
      "getBitbucketRepoPipelineStepLog", "getBitbucketRepoPullRequest",
      "getBitbucketRepoPullRequestDiff", "getBitbucketRepository", "getBitbucketWorkspace",
      "getCapacityPlanAllocations", "getConfluenceAttachment", "getConfluenceComment",
      "getConfluenceContent", "getConfluenceContentPermissions",
      "getConfluenceContentRestrictionState", "getConfluenceContentSuggestions",
      "getConfluenceContentVersion", "getConfluenceMauiApp", "getConfluencePersonalSpace",
      "getConfluencePublicLinkStatus", "getConfluenceReactions", "getConfluenceSpace",
      "getConfluenceSpaceInstructions", "getConfluenceTask", "getConfluenceTemplate",
      "getContentFormatGuide", "getFocusArea", "getFocusAreaCustomFields", "getFocusAreaTypes",
      "getGoal", "getGoalTypes", "getGoalUpdate", "getInsightsResource",
      "getInsightsResourceLineage", "getJiraAlignItem", "getJiraAlignTerminology",
      "getJiraBoardConfig", "getJiraBoardIssueData", "getJiraBoardSprintData",
      "getJiraCurrentUser", "getJiraEntityProperty", "getJiraIssue",
      "getJiraIssueTypeMetaWithFields", "getJiraProjectVersionRelatedWork",
      "getJiraProjectVersions", "getJiraUser", "getJsmAgentAvailability", "getJsmOpsAlerts",
      "getJsmOpsScheduleInfo", "getJsmOpsTeamInfo", "getJsmRequest",
      "getJsmRequestActionMetadata", "getJsmRequestCreationOptions",
      "getJsmRequestResolverPlans", "getJsmRequestTypeFields", "getLoomObjectsContent",
      "getLoomVideoDownloadUrl", "getProject", "getProjectUpdate", "getTalentFields",
      "getTalentGroupMetrics", "getTalentPosition", "getTalentPositionsByEntity",
      "getTalentUser", "getTeam", "listAssetsObjectSchemas", "listAssetsObjectTypeAttributes",
      "listBitbucketRepoCommitReports", "listBitbucketRepoDeployments",
      "listBitbucketRepoEnvironments", "listBitbucketRepoPipelineSteps",
      "listBitbucketRepoPipelines", "listBitbucketRepoPullRequestComments",
      "listBitbucketRepoPullRequestTasks", "listBitbucketRepoPullRequests",
      "listBitbucketRepositories", "listBitbucketWorkspaces", "listConfluenceAttachments",
      "listConfluenceComments", "listConfluenceContent", "listConfluenceContentVersions",
      "listConfluenceSpaces", "listConfluenceTasks", "listConfluenceTemplates",
      "listJiraAlignItems", "listJiraBoardSprints", "listJiraBoards", "listJiraDashboards",
      "listJiraFilters", "listJiraIssueAssignableUsers", "listJiraIssueChangelogs",
      "listJiraIssueComments", "listJiraIssueLinkTypes", "listJiraIssueRemoteIssueLinks",
      "listJiraIssueTransitions", "listJiraIssueWorklogs", "listJiraProjectComponents",
      "listJiraProjectIssueTypesMetadata", "listJiraProjects", "listJiraStatuses",
      "listLoomObjectFolders", "listLoomObjects", "lookupJiraAccountId",
      "queryAssetsObjectSchemaAttributes", "queryAssetsObjectTypes", "queryAssetsObjects",
      "queryAssetsObjectsUsingAql", "queryAssetsReferenceTypes",
      "resolveConfluenceContentMacros", "searchAssetsObjects",
      "searchCapacityPlanNonProjectWork", "searchConfluence", "searchFocusAreas", "searchGoals",
      "searchInsightsResources", "searchJiraIssuesUsingJql", "searchJsmRequests",
      "searchProjects", "searchTalentPositions", "searchTalentSkillTaxonomy", "searchTeams",
    ],
    notes:
      "Search and other enriched tools may consume Rovo credits. OAuth only here; Atlassian's admin API-token setting applies to token authentication, which this connector does not offer. No URL-level read-only mode.",
  },

  gitlab: {
    id: "gitlab",
    displayName: "GitLab",
    description: "Work with GitLab repositories, merge requests, and CI.",
    category: "Dev tools",
    logo: "/integrations/gitlab.svg",
    mcpUrl: "https://gitlab.com/api/v4/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["gitlab.com"],
    supportsReadOnly: false,
    scope: {
      queryParams: [],
      headers: [
        { header: "X-Gitlab-Enabled-Mcp-Server-Toolsets", value: { kind: "list", field: "toolsets", encoding: "csv" } },
      ],
    },
    // https://docs.gitlab.com/user/model_context_protocol/mcp_server/#select-tool-groups-toolsets
    scopeOptions: {
      toolsets: [
        { id: "core", enabledByDefault: true },
        { id: "merge_requests", enabledByDefault: true },
        { id: "work_items", enabledByDefault: true },
        { id: "repository", enabledByDefault: true },
        { id: "ci", enabledByDefault: true },
        // Listed by default only when the account has access to the platform.
        { id: "duo_agent_platform", enabledByDefault: true },
        { id: "wikis", enabledByDefault: false },
        { id: "code_security", enabledByDefault: false },
      ],
    },
    // Published fixed inventory, including superseded callable tools: https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/
    destructiveTools: [
      "save_project",
      "save_note",
      "create_merge_request_note",
      "create_workitem_note",
      "save_merge_request",
      "create_merge_request",
      "update_merge_request",
      "save_merge_request_review",
      "accept_merge_request",
      "link_work_items",
      "save_work_item",
      "create_work_item",
      "update_work_item",
      "create_issue",
      "add_branch",
      "create_branch",
      "fork_repository",
      "add_commit",
      "save_pipeline",
      "manage_pipeline",
      "start_duo_session",
      "send_duo_session_input",
      "save_vulnerability",
      "attach_scan_profile",
    ],
    // Reads from the inventory above, including documented aliases.
    readOnlyTools: [
      "get_artifact_file", "get_commit", "get_duo_session", "get_duo_workflow_status",
      "get_issue", "get_job", "get_job_log", "get_mcp_server_version", "get_merge_request",
      "get_merge_request_commits", "get_merge_request_conflicts", "get_merge_request_diffs",
      "get_merge_request_notes", "get_merge_request_pipelines", "get_pages_content",
      "get_pipeline", "get_pipeline_jobs", "get_project", "get_repository_file",
      "get_saved_view_work_items", "get_user", "get_vulnerability", "get_work_item",
      "get_work_item_types", "get_workitem_notes", "list_branches", "list_commits",
      "list_duo_agents_and_flows", "list_duo_sessions", "list_groups", "list_merge_requests",
      "list_pipeline_schedules", "list_pipelines", "list_project_members", "list_projects",
      "list_releases", "list_repository_tree", "list_tags", "list_todos", "list_user_events",
      "list_vulnerabilities", "list_wiki_pages", "list_work_item_saved_views",
      "list_work_items", "search", "search_labels",
    ],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Fine-grained personal access token with MCP tool Execute permission",
    },
    notes:
      "Legacy personal, project, and group access tokens return 403; use OAuth or a fine-grained PAT with MCP tool Execute permission. Narrow toolsets to stay within the tool limit. Orbit's external, dynamic tools are not supported; do not select orbit or all. No URL-level read-only mode.",
  },

  clerk: {
    id: "clerk",
    displayName: "Clerk",
    description: "Manage Clerk applications, users, and authentication settings.",
    category: "Authentication",
    logo: "/integrations/clerk.svg",
    mcpUrl: "https://mcp.clerk.com/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.clerk.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Full account-tool inventory: https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server#available-tools
    destructiveTools: [
      "create_application",
      "patch_instance_config",
      "put_instance_config",
      "create_user",
      "update_user",
      "update_user_metadata",
      "check_domain_dns",
      "create_production_instance",
      "set_oauth_provider_credentials",
      "configure_mcp_server",
      "check_mcp_server",
      "submit_feedback",
    ],
    // Reads from the inventory above.
    readOnlyTools: [
      "clerk_sdk_snippet", "get_domain_status", "get_instance_config",
      "get_instance_config_schema", "list_application_feedback",
      "list_clerk_sdk_snippets", "list_domains", "list_organization_memberships",
      "list_organizations", "list_user_organization_memberships", "list_users", "whoami",
      // Returns publishable keys only, which are public by design; never secret keys.
      "list_applications",
      // Returns publishable keys only, which are public by design; never secret keys.
      "get_application",
    ],
    notes:
      "Acts as your Clerk Dashboard account in the selected workspace. No URL-level read-only mode; production-instance creation cannot be undone.",
  },

  exa: {
    id: "exa",
    displayName: "Exa",
    description: "Search the web, read pages, and run multi-step research.",
    category: "Search",
    logo: "/integrations/exa.svg",
    mcpUrl: "https://mcp.exa.ai/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["mcp.exa.ai"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Full published inventory: https://docs.exa.ai/reference/exa-mcp#available-tools
    // agent_run is usage-billed, so it is gated as spend.
    destructiveTools: ["agent_run"],
    // Public-web reads from the inventory above. web_search_advanced_exa stays
    // gated: summaries, subpage crawling and up to 100 results bill crawl and LLM spend in one call.
    readOnlyTools: ["web_search_exa", "web_fetch_exa"],
    apiKey: {
      header: "x-api-key",
      valuePrefix: "",
      hint: "Exa API key",
    },
    notes:
      "Search and fetch only read the public web; agent_run is usage-billed and always needs approval. Note that " +
      "this server also answers unauthenticated and invalid-credential requests on its keyless tier (rate-limited, " +
      "no agent_run), so a successful connection probe does not prove the key or token is valid — it only proves " +
      "the server is reachable. No URL-level read-only mode.",
  },

  tavily: {
    id: "tavily",
    displayName: "Tavily",
    description: "Search, extract, crawl, and map the web for current sources.",
    category: "Search",
    logo: "/integrations/tavily.svg",
    mcpUrl: "https://mcp.tavily.com/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.tavily.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Full published inventory: https://docs.tavily.com/documentation/mcp#what-you-get
    // Every tool reads the public web; tavily_research is a long multi-source run, gated as spend.
    destructiveTools: ["tavily_research"],
    // Public-web reads from the inventory above. tavily_crawl runs a billed multi-page job, so it stays gated.
    readOnlyTools: ["tavily_search", "tavily_extract", "tavily_map"],
    notes:
      "OAuth only here; Tavily's documented key option puts the key in the MCP URL query string. Connecting with OAuth uses the account's mcp_auth_default API key, which Tavily creates if it does not exist. All tools consume Tavily credits. No URL-level read-only mode.",
  },

  firecrawl: {
    id: "firecrawl",
    displayName: "Firecrawl",
    description: "Scrape, crawl, and search the web, or operate a live page.",
    category: "Search",
    logo: "/integrations/firecrawl.svg",
    mcpUrl: "https://mcp.firecrawl.dev/v2/mcp-oauth",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.firecrawl.dev"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Full published inventory: https://docs.firecrawl.dev/mcp-server/tools and
    // https://github.com/firecrawl/firecrawl-mcp-server#available-tools, plus the
    // deprecated but still-registered firecrawl_extract. Billed enrichment, jobs
    // and extraction calls are gated as spend despite their readOnlyHint.
    destructiveTools: [
      "firecrawl_interact",
      "firecrawl_interact_stop",
      "firecrawl_agent",
      "firecrawl_monitor_create",
      "firecrawl_monitor_update",
      "firecrawl_monitor_run",
      "firecrawl_monitor_delete",
      "firecrawl_feedback",
      "firecrawl_search_feedback",
      "alexandria_library_read",
      "people_company_search",
      "people_company_enrich",
      "jobs_search",
      "firecrawl_extract",
    ],
    // Reads from the inventory above. Left gated: firecrawl_scrape (billed per
    // call, incl. Alexandria runs), firecrawl_crawl (starts a billed job),
    // firecrawl_parse (returns a signed upload target), monitor list/get
    // (webhook configuration) and firecrawl_credit_usage (per-key billing).
    // firecrawl_search is also gated: with scrapeOptions each result bills as an uncapped scrape.
    readOnlyTools: [
      "firecrawl_map", "firecrawl_check_crawl_status",
      "firecrawl_agent_status", "firecrawl_developer_search", "firecrawl_gov_search",
      "firecrawl_research_search_papers", "firecrawl_research_related_papers",
      "firecrawl_research_read_paper", "firecrawl_research_inspect_paper",
      "firecrawl_find_tools", "alexandria_library_search",
      "firecrawl_monitor_checks", "firecrawl_monitor_check",
    ],
    notes:
      "OAuth endpoint only; API-key connections use a different endpoint and are not offered yet. Interact can click and submit forms on live sites, and monitors can send webhooks or email, so both are gated. Scrape with Alexandria provider calls is billed per call but cannot be gated by name. No URL-level read-only mode.",
  },

  huggingface: {
    id: "huggingface",
    displayName: "Hugging Face",
    description: "Explore models, datasets, Spaces, and papers, and run Hub jobs.",
    category: "AI",
    logo: "/integrations/huggingface.svg",
    mcpUrl: "https://huggingface.co/mcp",
    authModes: ["oauth", "api_key"],
    trustedHostnames: ["huggingface.co"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Built-in inventory: https://github.com/huggingface/hf-mcp-server/blob/main/packages/mcp/src/tool-ids.ts
    // hf_jobs and the sandbox tools mix read and write operations, so each is gated as a whole.
    destructiveTools: [
      "create_repo",
      "hf_fs_write",
      "hf_jobs",
      "hf_sandbox",
      "hf_sandbox_exec",
      "hf_sandbox_fs",
      "dynamic_space",
    ],
    // Hub reads from the inventory above. hf_whoami is left gated because it
    // describes the connected credential and its permissions.
    readOnlyTools: ["hub_repo_search", "hub_repo_details", "hf_fs"],
    apiKey: {
      header: "Authorization",
      valuePrefix: "Bearer ",
      hint: "Hugging Face access token (hf_...)",
    },
    notes:
      "The advertised tools follow the account's MCP settings on huggingface.co. Jobs and sandboxes run billed compute. Space tools added in those settings are labelled destructive by the server and so require approval. Prefer a fine-grained, read-only token. No URL-level read-only mode.",
  },

  webflow: {
    id: "webflow",
    displayName: "Webflow",
    description: "Build pages, manage CMS content, and publish Webflow sites.",
    category: "Content",
    logo: "/integrations/webflow.svg",
    mcpUrl: "https://mcp.webflow.com/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.webflow.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Every tool tagged "write" in the full inventory (each tool fronts several
    // actions, so one write action gates the whole tool), plus get_more_tools,
    // which requests capabilities beyond the loaded set, and ask_webflow_ai,
    // which is AI-backed and may spend:
    // https://developers.webflow.com/mcp/tools/data-tools
    // https://developers.webflow.com/mcp/tools/designer-tools
    // https://developers.webflow.com/mcp/tools/utility-tools
    destructiveTools: [
      "data_agent_instructions_tool",
      "data_apps_tool",
      "data_assets_tool",
      "data_campaigns_tool",
      "data_cms_tool",
      "data_comments_tool",
      "data_component_builder",
      "data_component_props_tool",
      "data_component_tool",
      "data_component_variants_tool",
      "data_element_builder",
      "data_element_settings_tool",
      "data_element_tool",
      "data_enterprise_tool",
      "data_fonts_tool",
      "data_forms_tool",
      "data_interactions_tool",
      "data_localization_tool",
      "data_members_tool",
      "data_pages_tool",
      "data_scripts_tool",
      "data_sitemap_tool",
      "data_sites_tool",
      "data_style_tool",
      "data_variable_tool",
      "data_webhook_tool",
      "data_whtml_builder",
      "asset_tool",
      "designer_tool",
      "get_more_tools",
      "ask_webflow_ai",
    ],
    // Tools tagged read-only in the same references.
    readOnlyTools: [
      "data_aeo_tool", "data_analyze_tool", "data_optimize_tool",
      "element_snapshot_tool", "get_asset_preview", "webflow_guide_tool",
    ],
    notes:
      "Each authorization covers one workspace. Element snapshots, image uploads, and reading or changing the Designer selection, page, mode, branch, canvas or breakpoints need the Webflow Designer open with the MCP Bridge App connected. No URL-level read-only mode.",
  },

  netlify: {
    id: "netlify",
    displayName: "Netlify",
    description: "Create projects, deploy sites, and manage Netlify project settings.",
    category: "Hosting",
    logo: "/integrations/netlify.svg",
    mcpUrl: "https://mcp.netlify.com/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.netlify.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Docs publish no tool table; names come from the official server source
    // (https://github.com/netlify/netlify-mcp, src/tools). The default surface
    // groups operations into netlify-<domain>-services-{reader,updater}
    // dispatchers; the per-operation names are its ?verbose=true surface. The
    // team reader returns team environment variables, and request logs can hold
    // printed secrets, so those readers are gated too.
    destructiveTools: [
      "netlify-deploy-services-updater",
      "netlify-project-services-updater",
      "netlify-extension-services-updater",
      "netlify-feedback-services-updater",
      "netlify-team-services-reader",
      "netlify-deploy-site",
      "netlify-project-update-visitor-access-controls",
      "netlify-project-update-forms",
      "netlify-project-manage-form-submissions",
      "netlify-project-update-project-name",
      "netlify-project-manage-env-vars",
      "netlify-project-create-new-project",
      "netlify-extension-change-extension-installation",
      "netlify-submit-feedback",
      "netlify-team-get-team-env-vars",
      "netlify-observability-services-reader",
      "netlify-observability-get-request-logs",
      "netlify-observability-get-request-detail",
    ],
    // Per-operation reads annotated read-only in the same source, plus the
    // standalone deploy card and coding-context tools. The grouped readers are
    // dispatchers and stay unlisted.
    readOnlyTools: [
      "netlify-open-deployments", "netlify-refresh-deployments", "get-netlify-coding-context",
      "netlify-user-get-user", "netlify-deploy-get-deploy", "netlify-deploy-get-deploy-for-site",
      "netlify-project-get-project", "netlify-project-get-projects",
      "netlify-project-get-forms-for-project", "netlify-extension-get-extensions",
      "netlify-extension-get-full-extension-details", "netlify-get-database-setup-steps",
    ],
    notes:
      "OAuth only; the personal access token fallback applies to the local server, not this hosted endpoint. Renaming a project releases its old netlify.app subdomain. No URL-level read-only mode.",
  },

  railway: {
    id: "railway",
    displayName: "Railway",
    description: "Create projects, redeploy services, and manage Railway feature flags.",
    category: "Hosting",
    logo: "/integrations/railway.svg",
    mcpUrl: "https://mcp.railway.com",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.railway.com"],
    supportsReadOnly: false,
    scope: NO_URL_SCOPING,
    // Hosted-server inventory: https://docs.railway.com/ai/mcp-server#available-mcp-tools
    // railway-agent and the cloud-agent task tools act on the user's behalf;
    // starting a cloud agent is billed. Agents hold CLI credentials, so their
    // results and transcripts are gated as well.
    destructiveTools: [
      "create-project",
      "set-feature-flag",
      "delete-feature-flag",
      "redeploy",
      "accept-deploy",
      "railway-agent",
      "run-cloud-agent-task",
      "respond-cloud-agent-task",
      "cancel-cloud-agent-task",
      "check-cloud-agent-task",
      "get-cloud-agent-transcript",
    ],
    readOnlyTools: [
      "whoami", "list-projects", "list-services", "list-feature-flags",
      "get-feature-flag", "list-cloud-agent-tasks", "list-cloud-agent-models",
    ],
    // The resource's 401 challenge and protected-resource metadata both name
    // this scope; without it the token cannot reach any workspace.
    oauthScopes: ["workspace:member"],
    notes:
      "OAuth as a user; project tokens are not accepted. You choose the workspaces and projects at consent. Cloud agent tasks are billed. No URL-level read-only mode.",
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

/** Search display metadata only; category and query filters intersect. */
export function filterProviders(query: string, category?: string): readonly ProviderDefinition[] {
  const search = query.trim().toLowerCase();
  return listProviders().filter((provider) =>
    (!category || provider.category === category) &&
    `${provider.displayName} ${provider.description} ${provider.category}`
      .toLowerCase().includes(search),
  );
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
