import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { filterProviders, getProvider, listProviders } from "./catalog";

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

it("offers GitHub by PAT only until a pre-registered OAuth client exists (#539)", () => {
  expect(getProvider("github")?.authModes).toEqual(["api_key"]);
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

it("pins the exact public documentation read lists", () => {
  const publicDocs = listProviders().filter((provider) => provider.authModes.includes("none"));
  expect(publicDocs.map(({ id }) => id)).toEqual(["microsoft-learn", "cloudflare-docs"]);
  expect(publicDocs.map(({ readOnlyTools }) => readOnlyTools)).toEqual([
    ["microsoft_docs_search", "microsoft_docs_fetch", "microsoft_code_sample_search"],
    ["search_cloudflare_documentation", "migrate_pages_to_workers_guide"],
  ]);
  for (const provider of publicDocs) {
    expect(provider.authModes).toEqual(["none"]);
    expect(provider.supportsReadOnly).toBe(true);
    expect(provider.trustedHostnames).toEqual([new URL(provider.mcpUrl).hostname]);
    expect(provider.readOnlyTools?.filter((tool) => provider.destructiveTools.includes(tool))).toEqual([]);
  }
});
