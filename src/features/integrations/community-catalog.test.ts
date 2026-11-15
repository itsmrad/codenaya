import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PROVIDERS } from "./catalog";
import catalogJson from "./community-catalog.json";
import {
  COMMUNITY_AUTH,
  COMMUNITY_TRANSPORTS,
  filterCommunityServers,
  isRemoteCapable,
  listCommunityCategories,
  toCustomServerPrefill,
  type CommunityServer,
} from "./community-catalog";

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "must be https");

const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  repoUrl: httpsUrl.refine((value) => new URL(value).hostname === "github.com", "must be a GitHub URL"),
  description: z.string(),
  category: z.string().min(1),
  language: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  starsAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  official: z.boolean(),
  transport: z.enum(COMMUNITY_TRANSPORTS),
  remoteUrl: httpsUrl.optional(),
  auth: z.enum(COMMUNITY_AUTH),
}).strict().refine((entry) => (entry.transport === "stdio") === (entry.remoteUrl === undefined), {
  message: "remoteUrl is present exactly when the transport is remote",
});

const servers = catalogJson as CommunityServer[];

describe("community-catalog.json", () => {
  it("holds at least 500 valid entries", () => {
    expect(servers.length).toBeGreaterThanOrEqual(500);
    for (const entry of servers) expect(entrySchema.safeParse(entry), entry.id).toMatchObject({ success: true });
  });

  it("has unique ids that never collide with the vetted registry or the custom id", () => {
    const ids = servers.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reserved of [...Object.keys(PROVIDERS), "custom"]) expect(ids).not.toContain(reserved);
  });

  it("is sorted by stars, then id, so regeneration diffs stay readable", () => {
    const sorted = [...servers].sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
    expect(servers.map((entry) => entry.id)).toEqual(sorted.map((entry) => entry.id));
  });

  it("offers remote endpoints only with an http or sse transport", () => {
    const remote = servers.filter(isRemoteCapable);
    expect(remote.length).toBeGreaterThan(0);
    for (const entry of remote) expect(["http", "sse"]).toContain(entry.transport);
  });
});

const make = (overrides: Partial<CommunityServer>): CommunityServer => ({
  id: "a", name: "a/a", repoUrl: "https://github.com/a/a", description: "", category: "Databases",
  language: null, stars: 1, starsAsOf: "2026-01-01", official: false, transport: "stdio", auth: "unknown",
  ...overrides,
});

describe("filterCommunityServers", () => {
  const sample = [
    make({ id: "pg", name: "zeta/postgres", description: "Query Postgres", stars: 10 }),
    make({ id: "notes", name: "alpha/notes", category: "Knowledge & Memory", stars: 50 }),
    make({ id: "pg-2", name: "beta/pg", description: "postgres tools", stars: 10 }),
  ];

  it("sorts by most stars by default, ties by id", () => {
    expect(filterCommunityServers(sample, {}).map((s) => s.id)).toEqual(["notes", "pg", "pg-2"]);
  });

  it("sorts by name on request", () => {
    expect(filterCommunityServers(sample, { sort: "name" }).map((s) => s.name)).toEqual(["alpha/notes", "beta/pg", "zeta/postgres"]);
  });

  it("searches name and description case-insensitively and filters by category", () => {
    expect(filterCommunityServers(sample, { query: " POSTGRES " }).map((s) => s.id)).toEqual(["pg", "pg-2"]);
    expect(filterCommunityServers(sample, { category: "Knowledge & Memory" }).map((s) => s.id)).toEqual(["notes"]);
    expect(filterCommunityServers(sample, { query: "postgres", category: "Knowledge & Memory" })).toEqual([]);
  });

  it("lists categories alphabetically, once each", () => {
    expect(listCommunityCategories(sample)).toEqual(["Databases", "Knowledge & Memory"]);
  });
});

describe("toCustomServerPrefill", () => {
  it("prefills the custom form for a remote server and refuses stdio-only ones", () => {
    const remote = make({ name: "acme/hub", transport: "http", remoteUrl: "https://mcp.acme.example/mcp" });
    expect(toCustomServerPrefill(remote)).toEqual({ label: "acme/hub", serverUrl: "https://mcp.acme.example/mcp" });
    expect(toCustomServerPrefill(make({}))).toBeNull();
    expect(toCustomServerPrefill(make({ name: "x".repeat(120), transport: "sse", remoteUrl: "https://a.example/sse" }))?.label).toHaveLength(80);
  });
});
