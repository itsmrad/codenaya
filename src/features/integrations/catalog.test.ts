import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { filterProviders, listProviders } from "./catalog";

describe("provider catalog display metadata", () => {
  it.each(listProviders())("has complete display metadata and a local logo for $id", (provider) => {
    expect(provider.displayName.trim()).not.toBe("");
    expect(provider.description.trim()).not.toBe("");
    expect(provider.description.length).toBeLessThanOrEqual(90);
    expect(provider.category.trim()).not.toBe("");
    expect(provider.logo).toBe(`/integrations/${provider.id}.svg`);
    const svg = readFileSync(resolve("public", provider.logo.slice(1)), "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).not.toMatch(/<script|<foreignObject|https?:\/\/(?!www\.w3\.org)/i);
  });
});

describe("provider catalog filters", () => {
  it("keeps declaration order when the query is empty or whitespace", () => {
    expect(filterProviders("")).toEqual(listProviders());
    expect(filterProviders("   ")).toEqual(listProviders());
  });

  it("matches names, capabilities and categories without case sensitivity", () => {
    expect(filterProviders("  GITHUB  ").map(({ id }) => id)).toEqual(["github"]);
    expect(filterProviders("stack traces").map(({ id }) => id)).toEqual(["sentry"]);
    expect(filterProviders("DATABASE").map(({ id }) => id)).toEqual([
      "supabase", "neon", "prisma", "upstash", "planetscale", "notion",
    ]);
  });

  it("intersects search and category filters", () => {
    expect(filterProviders("Postgres", "Database").map(({ id }) => id)).toEqual(["neon", "prisma"]);
    expect(filterProviders("GitHub", "Database")).toEqual([]);
    expect(filterProviders("", "unknown")).toEqual([]);
    expect(filterProviders("no such integration")).toEqual([]);
  });

  it("does not search server URLs or security metadata", () => {
    expect(filterProviders("mcp.supabase.com")).toEqual([]);
    expect(filterProviders("X-MCP-Readonly")).toEqual([]);
  });
});
