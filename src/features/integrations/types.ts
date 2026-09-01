/**
 * Shared types for the MCP integration catalog.
 *
 * ## Why these types look the way they do
 *
 * Every hosted MCP provider lets the client narrow what the server exposes,
 * but no two of them agree on *how*. Across the nine providers Codenia ships
 * there are four genuinely different mechanisms:
 *
 *   (a) single-valued query params — Supabase `read_only`/`project_ref`,
 *       Neon `readonly`/`projectId`
 *   (b) repeatable query params — Neon `category` is sent once per category,
 *       so the same key legitimately appears several times
 *   (c) HTTP headers — GitHub `X-MCP-Toolsets` / `X-MCP-Readonly`
 *   (d) URL path — Sentry appends `/{org}/{project}` segments, Linear exposes
 *       read-only mode as an entirely different path (`/mcp/readonly`)
 *
 * The naive shape for this is a `switch (providerId)` inside the URL builder.
 * That collapses the moment a tenth provider arrives and makes the builder
 * impossible to test without also testing the catalog. So instead each provider
 * *declares* its mechanisms as data (`ProviderScopeCapabilities`) and the
 * builder is a generic interpreter of those declarations. Adding a provider is
 * a catalog edit; it is never a builder edit.
 *
 * The declarations reference `ProjectScopeSelection` fields by name, and those
 * names are unions rather than `string`, so a typo in a rule is a compile
 * error instead of a silently-dropped scope restriction.
 */

/** How Codenia authenticates to a provider's MCP endpoint. */
export type IntegrationAuthMode = "oauth" | "api_key";

/** Boolean fields of `ProjectScopeSelection` a scope rule may read. */
export type ScopeFlagField = "readOnly" | "experimental";

/** Single-string fields of `ProjectScopeSelection` a scope rule may read. */
export type ScopeStringField = "projectRef" | "orgSlug" | "projectSlug";

/** String-list fields of `ProjectScopeSelection` a scope rule may read. */
export type ScopeListField = "categories" | "features" | "toolsets";

/**
 * How a list of values is serialised.
 *
 * `csv` produces `key=a,b,c`; `repeat` produces `key=a&key=b&key=c`. Neon is
 * the only provider needing `repeat`, and getting it wrong is silent — the
 * server simply sees one category instead of three — so the distinction is
 * encoded in the type rather than left to the caller.
 */
export type ScopeListEncoding = "csv" | "repeat";

/**
 * Where a scope rule gets its value from, and how that value becomes a string.
 *
 * Generic over the permitted list encodings so that `repeat`, which is
 * meaningless for the header mechanism, can be excluded at the type level.
 */
export type ScopeValueSource<E extends ScopeListEncoding = ScopeListEncoding> =
  | {
      readonly kind: "flag";
      readonly field: ScopeFlagField;
      /** Literal emitted when the flag is true. Nothing is emitted when false. */
      readonly whenTrue: string;
    }
  | { readonly kind: "string"; readonly field: ScopeStringField }
  | {
      readonly kind: "list";
      readonly field: ScopeListField;
      readonly encoding: E;
    };

/** Mechanisms (a) and (b): a query parameter on the MCP URL. */
export interface QueryParamScopeRule {
  readonly param: string;
  readonly value: ScopeValueSource;
}

/**
 * Mechanism (c): an HTTP request header.
 *
 * Lists are restricted to `csv` because a repeated header would have to be
 * folded into a comma-joined value anyway, and no provider asks for that.
 */
export interface HeaderScopeRule {
  readonly header: string;
  readonly value: ScopeValueSource<"csv">;
}

/**
 * Mechanism (d), variant 1: hierarchical path segments appended to the MCP URL.
 *
 * `segments` is ordered and each entry depends on the ones before it —
 * Sentry's `/mcp/{org}/{project}` has no way to express a project without an
 * organisation. The builder enforces that dependency.
 */
export interface PathSegmentsScopeRule {
  readonly kind: "segments";
  readonly segments: readonly ScopeStringField[];
}

/**
 * Mechanism (d), variant 2: read-only mode is a different endpoint entirely.
 *
 * Linear has no read-only flag; it publishes a separate read-only URL.
 */
export interface ReadOnlyPathScopeRule {
  readonly kind: "readonly-path";
  /** Used verbatim in place of `ProviderDefinition.mcpUrl` when read-only. */
  readonly readOnlyUrl: string;
}

export type PathScopeRule = PathSegmentsScopeRule | ReadOnlyPathScopeRule;

/**
 * The complete set of scoping mechanisms one provider supports.
 *
 * Providers with no URL-level scoping declare empty rule lists rather than
 * omitting the field, so the builder never needs a null check per mechanism.
 */
export interface ProviderScopeCapabilities {
  readonly queryParams: readonly QueryParamScopeRule[];
  readonly headers: readonly HeaderScopeRule[];
  readonly path?: PathScopeRule;
}

/**
 * A value the user may pick for a list-valued scope field.
 *
 * `enabledByDefault` describes what the *provider* does when the client sends
 * nothing at all, which is what the UI must pre-check to avoid silently
 * changing a connection's behaviour the first time it is edited.
 */
export interface ScopeListOption {
  readonly id: string;
  readonly enabledByDefault: boolean;
}

/** Selectable values per list field, keyed by the same names the rules use. */
export type ScopeListOptions = {
  readonly [F in ScopeListField]?: readonly ScopeListOption[];
};

/**
 * Where an API key goes when `authModes` includes `"api_key"`.
 *
 * Metadata only — the scope-URL builder never touches credentials, so this is
 * consumed by the transport layer.
 */
export interface ApiKeyPlacement {
  readonly header: string;
  readonly valuePrefix: string;
  /** Human-readable hint for the connect form, e.g. a key prefix. */
  readonly hint?: string;
}

/** A curated, operator-controlled MCP provider. */
export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  /** Default (unscoped) MCP endpoint. */
  readonly mcpUrl: string;
  readonly authModes: readonly IntegrationAuthMode[];
  /**
   * Hostnames only, for `assertSafeMcpUrl`'s `trustedHosts` option. Catalog
   * hosts are operator-controlled, so they skip DNS validation.
   */
  readonly trustedHostnames: readonly string[];
  /**
   * Whether the provider offers *any* read-only mechanism. When false, a
   * read-only request cannot be expressed in the URL and enforcement has to
   * happen at the tool-call gate instead.
   */
  readonly supportsReadOnly: boolean;
  readonly scope: ProviderScopeCapabilities;
  readonly scopeOptions?: ScopeListOptions;
  /**
   * Tools that mutate or destroy state. Drives the human-in-the-loop approval
   * gate, so this list is deliberately conservative.
   */
  readonly destructiveTools: readonly string[];
  readonly apiKey?: ApiKeyPlacement;
  /** Operator-facing caveats worth surfacing in the UI or in review. */
  readonly notes?: string;
}

/**
 * One project's chosen scope for one provider connection.
 *
 * A single flat shape covers all nine providers; each provider's rules read
 * only the fields that mean something to it and ignore the rest. That keeps
 * the persisted document identical across providers, which matters because
 * these selections are stored per project-connection link.
 */
export interface ProjectScopeSelection {
  /** Request the provider's read-only mode where one exists. */
  readonly readOnly: boolean;
  /** Supabase `project_ref` / Neon `projectId`. */
  readonly projectRef?: string;
  /** Neon tool categories (repeated query param). */
  readonly categories?: readonly string[];
  /** Supabase feature groups (comma-joined query param). */
  readonly features?: readonly string[];
  /** GitHub toolsets (comma-joined header). */
  readonly toolsets?: readonly string[];
  /** Sentry organisation slug (path segment). */
  readonly orgSlug?: string;
  /** Sentry project slug (path segment, requires `orgSlug`). */
  readonly projectSlug?: string;
  /** Sentry `experimental=1` opt-in. */
  readonly experimental?: boolean;
}

/** Result of resolving a provider plus a selection into a concrete target. */
export interface ScopedMcpTarget {
  readonly url: string;
  /**
   * Scoping headers only. Returned as a fresh mutable object so the transport
   * can add `Authorization` without copying.
   */
  readonly headers: Record<string, string>;
}
