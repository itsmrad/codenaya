/**
 * Community MCP servers: an UNREVIEWED tier generated from a public list by
 * scripts/mcp-catalog/build.mjs (see docs/INTEGRATIONS.md).
 *
 * Nothing here is trusted. These entries are never added to the vetted
 * registry in `catalog.ts`, never contribute `readOnlyTools` or
 * `destructiveTools`, and never make tool annotations trusted. A remote entry
 * connects through the ordinary custom-server path, so every one of its tools
 * goes through the approval gate.
 */

export const COMMUNITY_TRANSPORTS = ["http", "sse", "stdio"] as const;
export const COMMUNITY_AUTH = ["oauth", "api-key", "unknown"] as const;

export interface CommunityServer {
  id: string;
  name: string;
  repoUrl: string;
  description: string;
  category: string;
  language: string | null;
  stars: number;
  starsAsOf: string;
  official: boolean;
  transport: (typeof COMMUNITY_TRANSPORTS)[number];
  remoteUrl?: string;
  auth: (typeof COMMUNITY_AUTH)[number];
}

/** What the custom-server form is opened with for a community remote. */
export interface CustomServerPrefill {
  label: string;
  serverUrl: string;
}

export type CommunitySort = "stars" | "name";

/** Max label length accepted by the custom-server form. */
const MAX_LABEL = 80;

export const isRemoteCapable = (
  server: CommunityServer,
): server is CommunityServer & { remoteUrl: string } =>
  server.transport !== "stdio" && typeof server.remoteUrl === "string";

/** The custom-server form values for a remote entry; null for stdio-only ones. */
export function toCustomServerPrefill(server: CommunityServer): CustomServerPrefill | null {
  return isRemoteCapable(server)
    ? { label: server.name.slice(0, MAX_LABEL), serverUrl: server.remoteUrl }
    : null;
}

export function listCommunityCategories(servers: readonly CommunityServer[]): string[] {
  return [...new Set(servers.map((server) => server.category))].sort((a, b) => a.localeCompare(b));
}

export function filterCommunityServers(
  servers: readonly CommunityServer[],
  { query = "", category, sort = "stars" }: { query?: string; category?: string; sort?: CommunitySort },
): CommunityServer[] {
  const needle = query.trim().toLowerCase();
  const matches = servers.filter((server) =>
    (!category || server.category === category) &&
    (!needle || `${server.name} ${server.description} ${server.category}`.toLowerCase().includes(needle)));
  return matches.sort(sort === "name"
    ? (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    : (a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
}

let loading: Promise<readonly CommunityServer[]> | undefined;

/** Loaded on demand so ~200 KB of JSON stays out of the dialog's initial bundle. */
export function loadCommunityServers(): Promise<readonly CommunityServer[]> {
  loading ??= import("./community-catalog.json").then(
    (module) => module.default as CommunityServer[],
    (error: unknown) => { loading = undefined; throw error; },
  );
  return loading;
}
