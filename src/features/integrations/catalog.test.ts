import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  filterProviders,
  getProvider,
  resolveProviderMcpUrl,
  hasPreRegisteredClient,
  isDestructiveTool,
  isProviderVisible,
  listProviders,
  listVisibleProviders,
  offeredAuthModes,
  preRegisteredOAuthProviderIds,
} from "./catalog";
import { HIDDEN_UNTIL_PAYMENT_PROVIDER_CHOSEN } from "./hidden-until-payment-provider";

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

describe("providers hidden until a payment provider is chosen", () => {
  it("leaves Stripe out of the visible list and keeps every other provider", () => {
    const visible = listVisibleProviders().map(({ id }) => id);
    expect(HIDDEN_UNTIL_PAYMENT_PROVIDER_CHOSEN).toEqual(["stripe"]);
    expect(visible).not.toContain("stripe");
    expect(visible).toEqual(listProviders().map(({ id }) => id).filter((id) => id !== "stripe"));
    expect(visible).toHaveLength(listProviders().length - HIDDEN_UNTIL_PAYMENT_PROVIDER_CHOSEN.length);
    expect(isProviderVisible("stripe")).toBe(false);
    expect(isProviderVisible("supabase")).toBe(true);
    expect(isProviderVisible("vercel")).toBe(false);
  });

  it("still resolves Stripe for existing connections, with its approval gating", () => {
    const stripe = getProvider("stripe");
    expect(stripe).toMatchObject({ id: "stripe", displayName: "Stripe", logo: "/integrations/stripe.svg" });
    expect(listProviders().map(({ id }) => id)).toContain("stripe");
    expect(isDestructiveTool("stripe", "create_refund")).toBe(true);
  });

  it("restores Stripe when the hidden list is emptied", () => {
    expect(listVisibleProviders([])).toEqual(listProviders());
    expect(isProviderVisible("stripe", [])).toBe(true);
  });
});

describe("pre-registered OAuth clients (#539)", () => {
  const github = getProvider("github")!;

  it("gives GitHub OAuth through env-named client credentials and its trusted AS", () => {
    expect(github.authModes).toEqual(["oauth", "api_key"]);
    expect(github.trustedAuthorizationServerOrigins).toEqual(["https://github.com"]);
    expect(github.preRegisteredClient).toEqual({
      clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
      clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
    });
  });

  it.each(listProviders().filter((p) => p.preRegisteredClient))(
    "names env vars, never values, for $id",
    ({ preRegisteredClient }) => {
      for (const name of Object.values(preRegisteredClient!)) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    },
  );

  it("hides OAuth in the UI until the deployment lists the provider as configured", () => {
    expect(offeredAuthModes(github, "")).toEqual(["api_key"]);
    expect(offeredAuthModes(github, "other")).toEqual(["api_key"]);
    expect(offeredAuthModes(github, "github")).toEqual(["oauth", "api_key"]);
    // DCR providers are unaffected.
    expect(offeredAuthModes(getProvider("notion")!, "")).toEqual(getProvider("notion")!.authModes);
  });

  it("lists a provider only when both variables are set, and exposes ids only", () => {
    const id = "Iv1.client-id";
    const secret = "secret-value-not-real";
    expect(preRegisteredOAuthProviderIds({})).toBe("");
    expect(preRegisteredOAuthProviderIds({ GITHUB_OAUTH_CLIENT_ID: id })).toBe("");
    expect(preRegisteredOAuthProviderIds({ GITHUB_OAUTH_CLIENT_SECRET: secret })).toBe("");
    expect(preRegisteredOAuthProviderIds({ GITHUB_OAUTH_CLIENT_ID: id, GITHUB_OAUTH_CLIENT_SECRET: secret })).toBe("github");
    expect(hasPreRegisteredClient(github, { GITHUB_OAUTH_CLIENT_ID: id, GITHUB_OAUTH_CLIENT_SECRET: secret })).toBe(true);
    expect(hasPreRegisteredClient(getProvider("notion")!, {})).toBe(false);
  });
});

describe("provider catalog filters", () => {
  it("keeps declaration order when the query is empty or whitespace", () => {
    expect(filterProviders("")).toEqual(listVisibleProviders());
    expect(filterProviders("   ")).toEqual(listVisibleProviders());
  });

  it("never finds a hidden provider", () => {
    expect(filterProviders("stripe")).toEqual([]);
    expect(filterProviders("", "Payments")).toEqual([]);
  });

  it("matches names, capabilities and categories without case sensitivity", () => {
    expect(filterProviders("  GITHUB  ").map(({ id }) => id)).toEqual(["github"]);
    expect(filterProviders("stack traces").map(({ id }) => id)).toEqual(["sentry"]);
    expect(filterProviders("DATABASE").map(({ id }) => id)).toEqual([
      "supabase", "neon", "prisma", "upstash", "planetscale", "notion", "airtable",
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
  expect(publicDocs.map(({ id }) => id)).toEqual(["microsoft-learn", "cloudflare-docs", "langfuse"]);
  expect(publicDocs.map(({ readOnlyTools }) => readOnlyTools)).toEqual([
    ["microsoft_docs_search", "microsoft_docs_fetch", "microsoft_code_sample_search"],
    ["search_cloudflare_documentation", "migrate_pages_to_workers_guide"],
    ["searchLangfuseDocs", "getLangfuseDocsPage", "getLangfuseOverview"],
  ]);
  for (const provider of publicDocs) {
    expect(provider.authModes).toEqual(["none"]);
    // Only a server with no write tool may advertise itself as read-only.
    expect(provider.supportsReadOnly).toBe(provider.destructiveTools.length === 0);
    expect(provider.trustedHostnames).toEqual([new URL(provider.mcpUrl).hostname]);
    expect(provider.readOnlyTools?.filter((tool) => provider.destructiveTools.includes(tool))).toEqual([]);
  }
});

describe("per-auth-mode MCP URLs (#543)", () => {
  it.each(listProviders())("trusts every endpoint declared by $id", (provider) => {
    for (const url of [provider.mcpUrl, ...Object.values(provider.urlByAuthMode ?? {})]) {
      expect(provider.trustedHostnames).toContain(new URL(url).hostname);
    }
    for (const mode of provider.authModes) {
      expect(resolveProviderMcpUrl(provider, mode)).toBe(provider.urlByAuthMode?.[mode] ?? provider.mcpUrl);
    }
  });

  it("rejects an override outside the provider's trusted hostnames", () => {
    const provider = {
      ...getProvider("firecrawl")!,
      urlByAuthMode: { api_key: "https://untrusted.example.test/mcp" },
    };
    expect(() => resolveProviderMcpUrl(provider, "api_key")).toThrow("trustedHostnames");
  });

  it.each([
    ["supabase", "https://mcp.supabase.com/mcp"],
    ["github", "https://api.githubcopilot.com/mcp/"],
    ["neon", "https://mcp.neon.tech/mcp"],
  ])("preserves %s default URL bytes for every auth mode", (id, url) => {
    const provider = getProvider(id)!;
    expect(resolveProviderMcpUrl(provider)).toBe(url);
    for (const mode of provider.authModes) expect(resolveProviderMcpUrl(provider, mode)).toBe(url);
  });

  it("uses the default for unspecified modes and selects overrides independently", () => {
    const provider = {
      ...getProvider("firecrawl")!,
      urlByAuthMode: { oauth: "https://mcp.firecrawl.dev/other-oauth" },
    };
    expect(resolveProviderMcpUrl(provider, "oauth")).toBe("https://mcp.firecrawl.dev/other-oauth");
    expect(resolveProviderMcpUrl(provider, "api_key")).toBe(provider.mcpUrl);
    expect(resolveProviderMcpUrl(provider)).toBe(provider.mcpUrl);
  });
});
