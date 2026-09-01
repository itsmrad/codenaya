/**
 * Turns a provider definition plus a user's scope selection into a concrete
 * MCP target: one URL and any scoping headers.
 *
 * ## Why this is an interpreter and not a switch statement
 *
 * The nine catalog providers scope connections four different ways (query
 * params, repeatable query params, headers, URL path — see `../types.ts`). A
 * `switch (provider.id)` here would put nine unrelated behaviours in one
 * function and make every new provider a change to security-relevant code. So
 * providers declare their mechanisms as data and this module walks those
 * declarations. There is no provider id anywhere below.
 *
 * ## Why output must be byte-stable
 *
 * Callers snapshot these URLs and use them as cache keys for tool discovery.
 * If `{ categories: ["b", "a"] }` and `{ categories: ["a", "b"] }` produced
 * different strings, two identical connections would miss each other's cache
 * and re-discover tools on every request. So:
 *
 *   - parameter order follows the provider's declared rule order, never the
 *     insertion order of the selection object's keys;
 *   - list values are de-duplicated and sorted;
 *   - blank and whitespace-only values are dropped rather than emitted empty.
 *
 * ## What this module deliberately does not do
 *
 * It never touches credentials. The returned headers contain scoping headers
 * only; `Authorization` is added by the transport layer, which is also what
 * validates the final URL against the SSRF guard.
 */

import type {
  HeaderScopeRule,
  ProjectScopeSelection,
  ProviderDefinition,
  QueryParamScopeRule,
  ScopeFlagField,
  ScopeListField,
  ScopeStringField,
  ScopeValueSource,
  ScopedMcpTarget,
} from "../types";

function readFlag(
  selection: ProjectScopeSelection,
  field: ScopeFlagField,
): boolean {
  return selection[field] === true;
}

/** Trimmed string, or `undefined` when absent or blank. */
function readString(
  selection: ProjectScopeSelection,
  field: ScopeStringField,
): string | undefined {
  const raw = selection[field];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Normalised list value: trimmed, blanks dropped, de-duplicated, sorted.
 *
 * Sorting is what makes two selections that mean the same thing produce the
 * same URL. Every list field in the catalog is an unordered set of feature or
 * category names, so reordering carries no meaning to lose.
 */
function readList(
  selection: ProjectScopeSelection,
  field: ScopeListField,
): readonly string[] {
  const raw = selection[field];
  if (raw === undefined) return [];
  const cleaned = new Set<string>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed !== "") cleaned.add(trimmed);
  }
  return [...cleaned].sort();
}

/**
 * Resolve a rule's value source into zero or more serialised values.
 *
 * Zero values means "emit nothing", which is how an unset flag, a blank string
 * and an empty list all behave — omitting the parameter lets the provider apply
 * its own defaults instead of us guessing them.
 */
function resolveValues(
  source: ScopeValueSource,
  selection: ProjectScopeSelection,
): readonly string[] {
  switch (source.kind) {
    case "flag":
      return readFlag(selection, source.field) ? [source.whenTrue] : [];
    case "string": {
      const value = readString(selection, source.field);
      return value === undefined ? [] : [value];
    }
    case "list": {
      const values = readList(selection, source.field);
      if (values.length === 0) return [];
      return source.encoding === "csv" ? [values.join(",")] : values;
    }
  }
}

/**
 * Base URL before any scoping.
 *
 * A `readonly-path` provider (Linear) publishes read-only mode as a separate
 * endpoint, so read-only is resolved here rather than as a parameter.
 */
function resolveBaseUrl(
  provider: ProviderDefinition,
  selection: ProjectScopeSelection,
): string {
  const path = provider.scope.path;
  if (path?.kind === "readonly-path" && selection.readOnly) {
    return path.readOnlyUrl;
  }
  return provider.mcpUrl;
}

/**
 * Append hierarchical path segments (Sentry's `/mcp/{org}/{project}`).
 *
 * Segments are ordered and each one requires the ones before it. A project
 * without an organisation is not a URL Sentry can serve — it would silently
 * resolve to organisation-level scope under the project's name, which is
 * broader access than the user asked for. Rather than guess, this throws: the
 * selection is invalid and the caller must fix it before we open a connection.
 */
function applyPathSegments(
  url: URL,
  provider: ProviderDefinition,
  selection: ProjectScopeSelection,
  segments: readonly ScopeStringField[],
): void {
  const resolved: string[] = [];
  let missing: ScopeStringField | undefined;

  for (const field of segments) {
    const value = readString(selection, field);
    if (value === undefined) {
      missing ??= field;
      continue;
    }
    if (missing !== undefined) {
      throw new Error(
        `${provider.displayName} scoping requires "${missing}" to be set before "${field}".`,
      );
    }
    resolved.push(value);
  }

  if (resolved.length === 0) return;

  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${resolved.map(encodeURIComponent).join("/")}`;
}

function applyQueryParams(
  url: URL,
  selection: ProjectScopeSelection,
  rules: readonly QueryParamScopeRule[],
): void {
  // Rebuilt from scratch rather than mutated in place so ordering is a
  // function of the declared rules, not of however the base URL was written.
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    params.append(key, value);
  }

  for (const rule of rules) {
    for (const value of resolveValues(rule.value, selection)) {
      // `append`, never `set`: Neon's `category` is expected once per value.
      params.append(rule.param, value);
    }
  }

  // Left percent-encoded deliberately. `URLSearchParams` encodes a comma in a
  // joined value as `%2C`, and Supabase's own documentation shows exactly that
  // form (`?features=docs%2Caccount%2Cdatabase...`), so it has positive evidence
  // of working against a real provider. A literal comma is also legal per
  // RFC 3986 and would very likely work too, but it is unverified — and there is
  // no upside to deviating from the documented form.
  const search = params.toString();
  url.search = search === "" ? "" : `?${search}`;
}

function buildHeaders(
  selection: ProjectScopeSelection,
  rules: readonly HeaderScopeRule[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    const values = resolveValues(rule.value, selection);
    if (values.length === 0) continue;
    headers[rule.header] = values.join(",");
  }
  return headers;
}

/**
 * Build the scoped MCP URL and scoping headers for one connection.
 *
 * Inputs are never mutated; every value is copied before use.
 *
 * The URL is returned in WHATWG-normalised form, so a catalog entry written
 * without a path (`https://mcp.stripe.com`) comes back with the empty root path
 * (`https://mcp.stripe.com/`). Normalising unconditionally means one code path
 * and one canonical string per connection, which is what a cache key needs.
 *
 * When `selection.readOnly` is true but the provider offers no read-only
 * mechanism (`supportsReadOnly: false`), the flag is silently ignored here
 * because there is nothing in the URL to express it. Read-only intent for
 * those providers is enforced at the tool-call gate via
 * `isDestructiveTool`, not in the transport.
 *
 * @throws Error when the selection is internally inconsistent — currently only
 * a path segment supplied without its parent segment.
 */
export function buildScopedMcpUrl(
  provider: ProviderDefinition,
  selection: ProjectScopeSelection,
): ScopedMcpTarget {
  const url = new URL(resolveBaseUrl(provider, selection));

  const path = provider.scope.path;
  if (path?.kind === "segments") {
    applyPathSegments(url, provider, selection, path.segments);
  }

  applyQueryParams(url, selection, provider.scope.queryParams);

  return {
    url: url.toString(),
    headers: buildHeaders(selection, provider.scope.headers),
  };
}
