import { describe, expect, it } from "vitest";

import {
  getProvider,
  getTrustedHostnames,
  isDestructiveTool,
  listProviders,
  PROVIDERS,
  type ProviderId,
} from "../catalog";
import type { ProjectScopeSelection, ProviderDefinition } from "../types";

import { buildScopedMcpUrl } from "./scope-url";

/** Nothing scoped: what a connection looks like before the user narrows it. */
const UNSCOPED: ProjectScopeSelection = { readOnly: false };

function provider(id: ProviderId): ProviderDefinition {
  const definition = getProvider(id);
  if (!definition) throw new Error(`missing provider fixture: ${id}`);
  return definition;
}

function urlFor(id: ProviderId, selection: ProjectScopeSelection): string {
  return buildScopedMcpUrl(provider(id), selection).url;
}

describe("catalog", () => {
  it("exposes exactly the curated providers", () => {
    expect(listProviders().map((p) => p.id)).toEqual([
      "supabase",
      "neon",
      "github",
      "stripe",
      "context7",
      "prisma",
      "sentry",
      "cloudflare",
      "linear",
      "posthog",
      "resend",
      "upstash",
      "sanity",
      "planetscale",
      "notion",
      "atlassian",
      "gitlab",
      "clerk",
      "exa",
      "tavily",
      "firecrawl",
      "huggingface",
    ]);
  });

  it("does not include Vercel MCP, whose access is client-allowlisted", () => {
    expect(getProvider("vercel")).toBeUndefined();
    expect(getTrustedHostnames()).not.toContain("mcp.vercel.com");
  });

  it("keeps each definition's id in sync with its registry key", () => {
    for (const [key, definition] of Object.entries(PROVIDERS)) {
      expect(definition.id).toBe(key);
    }
  });

  it("declares a trusted hostname matching each MCP URL host", () => {
    for (const definition of listProviders()) {
      const { hostname } = new URL(definition.mcpUrl);
      expect(definition.trustedHostnames).toContain(hostname);
    }
  });

  it("returns undefined for unknown ids and inherited object keys", () => {
    expect(getProvider("not-a-provider")).toBeUndefined();
    expect(getProvider("constructor")).toBeUndefined();
    expect(getProvider("toString")).toBeUndefined();
  });

  it("resolves destructive tools per provider", () => {
    expect(isDestructiveTool("supabase", "execute_sql")).toBe(true);
    expect(isDestructiveTool("supabase", "list_tables")).toBe(false);
    // Cloudflare's Code Mode `execute` can perform any API mutation.
    expect(isDestructiveTool("cloudflare", "execute")).toBe(true);
    // Tool names are not shared across providers.
    expect(isDestructiveTool("neon", "execute_sql")).toBe(false);
    expect(isDestructiveTool("neon", "run_sql")).toBe(true);
    // Context7 only serves documentation.
    expect(PROVIDERS.context7.destructiveTools).toEqual([]);
  });

  it.each([
    ["notion", 32, ["notion-create-file-upload", "notion-update-enabled-skills", "notion-spawn-session", "notion-calendar-cancel-events"]],
    ["atlassian", 116, ["executeRead", "executeWrite", "executeDestructive", "replaceConfluenceContentPermissions", "queryInsightsSql", "queryInsightsAi"]],
    ["gitlab", 24, ["create_merge_request_note", "update_merge_request", "create_work_item", "create_branch", "manage_pipeline", "send_duo_session_input", "attach_scan_profile"]],
    ["clerk", 12, ["put_instance_config", "check_domain_dns", "set_oauth_provider_credentials", "configure_mcp_server", "check_mcp_server", "submit_feedback"]],
    ["exa", 1, ["agent_run"]],
    ["tavily", 1, ["tavily_research"]],
    ["firecrawl", 11, ["firecrawl_interact", "firecrawl_agent", "firecrawl_monitor_create", "firecrawl_monitor_delete", "alexandria_library_read", "people_company_enrich"]],
    ["huggingface", 7, ["create_repo", "hf_fs_write", "hf_jobs", "hf_sandbox", "hf_sandbox_exec", "hf_sandbox_fs", "dynamic_space"]],
  ] as const)("retains the audited %s write inventory, including indirect and configuration writes", (id, count, sensitive) => {
    const tools = PROVIDERS[id].destructiveTools;
    expect(tools).toHaveLength(count);
    expect(new Set(tools).size).toBe(count);
    expect(tools).toEqual(expect.arrayContaining([...sensitive]));
  });

  it("returns false rather than throwing for unknown providers", () => {
    expect(isDestructiveTool("nope", "anything")).toBe(false);
  });

  it.each([
    ["posthog", "exec"],
    ["resend", "send-email"], ["resend", "send-batch-emails"], ["resend", "send-broadcast"],
    ["resend", "send-inbox-draft"], ["resend", "reply-to-inbox-thread-email"],
    ["upstash", "redis_run_command"], ["upstash", "qstash_publish_message"],
    ["upstash", "redis_change_plan"], ["upstash", "qstash_set_plan"], ["upstash", "vector_upsert"],
    ["sanity", "publish_documents"], ["sanity", "deploy_schema"], ["sanity", "deploy_studio"],
    ["sanity", "add_cors_origin"], ["sanity", "cors_origins_delete"], ["sanity", "run_sanity_cli"],
    ["planetscale", "planetscale_execute_write_query"], ["planetscale", "planetscale_update_payment_method"],
  ])("marks the verified %s tool %s destructive", (id, tool) => {
    expect(isDestructiveTool(id, tool)).toBe(true);
  });

  it("returns a sorted, de-duplicated hostname allowlist", () => {
    const hostnames = getTrustedHostnames();
    expect(hostnames).toEqual([
      "api.githubcopilot.com",
      "gitlab.com",
      "huggingface.co",
      "mcp.atlassian.com",
      "mcp.clerk.com",
      "mcp.cloudflare.com",
      "mcp.context7.com",
      "mcp.exa.ai",
      "mcp.firecrawl.dev",
      "mcp.linear.app",
      "mcp.neon.tech",
      "mcp.notion.com",
      "mcp.posthog.com",
      "mcp.prisma.io",
      "mcp.pscale.dev",
      "mcp.resend.com",
      "mcp.sanity.io",
      "mcp.sentry.dev",
      "mcp.stripe.com",
      "mcp.supabase.com",
      "mcp.tavily.com",
      "mcp.upstash.com",
    ]);
    expect(new Set(hostnames).size).toBe(hostnames.length);
  });

  it("freezes definitions so a shared list cannot be widened at runtime", () => {
    expect(Object.isFrozen(PROVIDERS)).toBe(true);
    expect(Object.isFrozen(PROVIDERS.supabase)).toBe(true);
    expect(Object.isFrozen(PROVIDERS.supabase.destructiveTools)).toBe(true);
  });
});

describe("buildScopedMcpUrl — default (unscoped) URLs", () => {
  const cases: Array<[ProviderId, string]> = [
    ["supabase", "https://mcp.supabase.com/mcp"],
    ["neon", "https://mcp.neon.tech/mcp"],
    ["github", "https://api.githubcopilot.com/mcp/"],
    // Catalog entry has no path, so WHATWG normalisation adds the root slash.
    ["stripe", "https://mcp.stripe.com/"],
    ["context7", "https://mcp.context7.com/mcp"],
    ["prisma", "https://mcp.prisma.io/mcp"],
    ["sentry", "https://mcp.sentry.dev/mcp"],
    ["cloudflare", "https://mcp.cloudflare.com/mcp"],
    ["linear", "https://mcp.linear.app/mcp"],
    ["posthog", "https://mcp.posthog.com/mcp"],
    ["resend", "https://mcp.resend.com/mcp"],
    ["upstash", "https://mcp.upstash.com/mcp"],
    ["sanity", "https://mcp.sanity.io/"],
    ["planetscale", "https://mcp.pscale.dev/mcp/planetscale"],
    ["notion", "https://mcp.notion.com/mcp"],
    ["atlassian", "https://mcp.atlassian.com/v2/mcp"],
    ["gitlab", "https://gitlab.com/api/v4/mcp"],
    ["clerk", "https://mcp.clerk.com/mcp"],
    ["exa", "https://mcp.exa.ai/mcp"],
    ["tavily", "https://mcp.tavily.com/mcp"],
    ["firecrawl", "https://mcp.firecrawl.dev/v2/mcp-oauth"],
    ["huggingface", "https://huggingface.co/mcp"],
  ];

  for (const [id, expected] of cases) {
    it(`${id} falls back to its documented endpoint`, () => {
      expect(urlFor(id, UNSCOPED)).toBe(expected);
    });
  }

  it("emits no scoping headers when nothing is selected", () => {
    for (const definition of listProviders()) {
      expect(buildScopedMcpUrl(definition, UNSCOPED).headers).toEqual({});
    }
  });
});

describe("buildScopedMcpUrl — read-only per provider mechanism", () => {
  it("supabase uses the read_only query param", () => {
    expect(urlFor("supabase", { readOnly: true })).toBe(
      "https://mcp.supabase.com/mcp?read_only=true",
    );
  });

  it("neon uses the readonly query param", () => {
    expect(urlFor("neon", { readOnly: true })).toBe(
      "https://mcp.neon.tech/mcp?readonly=true",
    );
  });

  it("github uses the X-MCP-Readonly header, leaving the URL untouched", () => {
    const target = buildScopedMcpUrl(provider("github"), { readOnly: true });
    expect(target.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(target.headers).toEqual({ "X-MCP-Readonly": "true" });
  });

  it("linear switches to its separate read-only endpoint", () => {
    expect(urlFor("linear", { readOnly: true })).toBe(
      "https://mcp.linear.app/mcp/readonly",
    );
  });

  it("ignores readOnly for providers that cannot express it in the URL", () => {
    // Enforcement for these falls to the destructive-tool approval gate.
    for (const id of ["stripe", "context7", "prisma", "cloudflare", "sentry", "resend", "upstash", "sanity", "notion", "atlassian", "gitlab", "clerk", "exa", "tavily", "firecrawl", "huggingface"] as const) {
      expect(provider(id).supportsReadOnly).toBe(false);
      expect(urlFor(id, { readOnly: true })).toBe(urlFor(id, UNSCOPED));
      expect(buildScopedMcpUrl(provider(id), { readOnly: true }).headers).toEqual({});
    }
  });
});

describe("buildScopedMcpUrl — backend services", () => {
  it("combines PostHog feature and project scope with its read-only header", () => {
    expect(buildScopedMcpUrl(provider("posthog"), {
      readOnly: true, features: ["insights", "flags", "flags"], projectRef: " 123 ",
    })).toEqual({
      url: "https://mcp.posthog.com/mcp?features=flags%2Cinsights&project_id=123",
      headers: { "x-posthog-read-only": "true" },
    });
  });

  it("sends Upstash groups only when explicitly selected, without a read-only flag", () => {
    expect(buildScopedMcpUrl(provider("upstash"), {
      readOnly: true, features: ["vector_search", "redis", "qstash_workflow"], projectRef: "ignored",
    })).toEqual({
      url: "https://mcp.upstash.com/mcp?features=qstash_workflow%2Credis%2Cvector_search",
      headers: {},
    });
    expect(urlFor("upstash", { readOnly: true, features: [] })).toBe(
      "https://mcp.upstash.com/mcp",
    );
    expect(urlFor("upstash", { readOnly: true, features: ["redis"] })).toBe(
      "https://mcp.upstash.com/mcp?features=redis",
    );
  });

  it("uses PlanetScale's Insights-only endpoint without pretending to scope a database", () => {
    expect(provider("planetscale").supportsReadOnly).toBe(false);
    expect(buildScopedMcpUrl(provider("planetscale"), {
      readOnly: true, projectRef: "ignored", features: ["ignored"],
    })).toEqual({
      url: "https://mcp.pscale.dev/mcp/planetscale-insights-only",
      headers: {},
    });
  });

  it.each(["resend", "sanity"] as const)("does not invent %s URL scoping", (id) => {
    expect(buildScopedMcpUrl(provider(id), {
      readOnly: true, projectRef: "ignored", features: ["ignored"], orgSlug: "ignored",
    })).toEqual({ url: urlFor(id, UNSCOPED), headers: {} });
  });
});

describe("buildScopedMcpUrl — Supabase", () => {
  it("comma-joins the features list", () => {
    expect(
      urlFor("supabase", { readOnly: false, features: ["database", "docs"] }),
    ).toBe("https://mcp.supabase.com/mcp?features=database%2Cdocs");
  });

  it("combines features, read_only and project_ref in declared order", () => {
    expect(
      urlFor("supabase", {
        readOnly: true,
        features: ["database", "docs", "storage"],
        projectRef: "abcdefghijklmnop",
      }),
    ).toBe(
      "https://mcp.supabase.com/mcp?features=database%2Cdocs%2Cstorage&read_only=true&project_ref=abcdefghijklmnop",
    );
  });

  it("omits an empty features list so provider defaults apply", () => {
    expect(urlFor("supabase", { readOnly: false, features: [] })).toBe(
      "https://mcp.supabase.com/mcp",
    );
  });

  it("drops blank entries and blank strings rather than emitting empty params", () => {
    expect(
      urlFor("supabase", {
        readOnly: false,
        features: ["database", "  ", ""],
        projectRef: "   ",
      }),
    ).toBe("https://mcp.supabase.com/mcp?features=database");
  });

  it("trims surrounding whitespace on values", () => {
    expect(
      urlFor("supabase", {
        readOnly: false,
        features: [" database "],
        projectRef: " ref-1 ",
      }),
    ).toBe("https://mcp.supabase.com/mcp?features=database&project_ref=ref-1");
  });

  it("lists storage as off by default, matching Supabase's own behaviour", () => {
    const storage = PROVIDERS.supabase.scopeOptions?.features?.find(
      (option) => option.id === "storage",
    );
    expect(storage?.enabledByDefault).toBe(false);
  });
});

describe("buildScopedMcpUrl — Neon", () => {
  it("repeats the category key once per category", () => {
    expect(
      urlFor("neon", {
        readOnly: false,
        categories: ["projects", "branches", "querying"],
      }),
    ).toBe(
      "https://mcp.neon.tech/mcp?category=branches&category=projects&category=querying",
    );
  });

  it("does not collapse repeated categories into a comma-joined value", () => {
    const url = urlFor("neon", { readOnly: false, categories: ["schema", "docs"] });
    expect(url).not.toContain(",");
    expect(new URL(url).searchParams.getAll("category")).toEqual(["docs", "schema"]);
  });

  it("de-duplicates repeated categories", () => {
    expect(
      urlFor("neon", { readOnly: false, categories: ["schema", "schema", "docs"] }),
    ).toBe("https://mcp.neon.tech/mcp?category=docs&category=schema");
  });

  it("combines projectId with readonly", () => {
    expect(
      urlFor("neon", { readOnly: true, projectRef: "cool-project-12345" }),
    ).toBe("https://mcp.neon.tech/mcp?readonly=true&projectId=cool-project-12345");
  });

  it("maps the shared projectRef field onto Neon's projectId param", () => {
    const url = new URL(urlFor("neon", { readOnly: false, projectRef: "p1" }));
    expect(url.searchParams.get("projectId")).toBe("p1");
    expect(url.searchParams.get("project_ref")).toBeNull();
  });

  it("emits all three mechanisms together in declared order", () => {
    expect(
      urlFor("neon", {
        readOnly: true,
        categories: ["querying", "schema"],
        projectRef: "p1",
      }),
    ).toBe(
      "https://mcp.neon.tech/mcp?category=querying&category=schema&readonly=true&projectId=p1",
    );
  });
});

describe("buildScopedMcpUrl — GitHub headers", () => {
  it("comma-joins toolsets into X-MCP-Toolsets", () => {
    const target = buildScopedMcpUrl(provider("github"), {
      readOnly: false,
      toolsets: ["repos", "issues"],
    });
    expect(target.headers).toEqual({ "X-MCP-Toolsets": "issues,repos" });
    expect(target.url).toBe("https://api.githubcopilot.com/mcp/");
  });

  it("emits both scoping headers together", () => {
    const target = buildScopedMcpUrl(provider("github"), {
      readOnly: true,
      toolsets: ["issues", "pull_requests"],
    });
    expect(target.headers).toEqual({
      "X-MCP-Toolsets": "issues,pull_requests",
      "X-MCP-Readonly": "true",
    });
  });

  it("never puts GitHub scoping into the query string", () => {
    const target = buildScopedMcpUrl(provider("github"), {
      readOnly: true,
      toolsets: ["issues"],
      projectRef: "ignored",
      categories: ["ignored"],
    });
    expect(target.url).toBe("https://api.githubcopilot.com/mcp/");
  });

  it("returns headers as a mutable object the transport can extend", () => {
    const { headers } = buildScopedMcpUrl(provider("github"), { readOnly: true });
    headers.Authorization = "Bearer redacted";
    expect(headers).toEqual({
      "X-MCP-Readonly": "true",
      Authorization: "Bearer redacted",
    });
  });
});

describe("buildScopedMcpUrl — Sentry path scoping", () => {
  it("appends the organisation slug", () => {
    expect(urlFor("sentry", { readOnly: false, orgSlug: "acme" })).toBe(
      "https://mcp.sentry.dev/mcp/acme",
    );
  });

  it("appends organisation and project slugs", () => {
    expect(
      urlFor("sentry", { readOnly: false, orgSlug: "acme", projectSlug: "web-app" }),
    ).toBe("https://mcp.sentry.dev/mcp/acme/web-app");
  });

  it("combines path scoping with the experimental opt-in", () => {
    expect(
      urlFor("sentry", { readOnly: false, orgSlug: "acme", experimental: true }),
    ).toBe("https://mcp.sentry.dev/mcp/acme?experimental=1");
  });

  it("omits experimental when not requested", () => {
    expect(urlFor("sentry", { readOnly: false, experimental: false })).toBe(
      "https://mcp.sentry.dev/mcp",
    );
  });

  it("throws when a project slug arrives without an organisation slug", () => {
    // Silently dropping the project would widen scope to the whole
    // organisation, which is more access than the user selected.
    expect(() =>
      buildScopedMcpUrl(provider("sentry"), {
        readOnly: false,
        projectSlug: "web-app",
      }),
    ).toThrow(/requires "orgSlug" to be set before "projectSlug"/);
  });

  it("treats a blank organisation slug as missing", () => {
    expect(() =>
      buildScopedMcpUrl(provider("sentry"), {
        readOnly: false,
        orgSlug: "   ",
        projectSlug: "web-app",
      }),
    ).toThrow(/requires "orgSlug"/);
  });

  it("percent-encodes slugs so they cannot escape their segment", () => {
    expect(urlFor("sentry", { readOnly: false, orgSlug: "a/../b" })).toBe(
      "https://mcp.sentry.dev/mcp/a%2F..%2Fb",
    );
  });
});

describe("buildScopedMcpUrl — determinism", () => {
  it("produces identical output for the same selection", () => {
    const selection: ProjectScopeSelection = {
      readOnly: true,
      projectRef: "p1",
      categories: ["schema", "querying", "docs"],
    };
    expect(urlFor("neon", selection)).toBe(urlFor("neon", selection));
  });

  it("ignores the insertion order of selection keys", () => {
    const a: ProjectScopeSelection = {
      readOnly: true,
      projectRef: "abc",
      features: ["docs", "database"],
    };
    const b: ProjectScopeSelection = {
      features: ["docs", "database"],
      projectRef: "abc",
      readOnly: true,
    };
    expect(urlFor("supabase", a)).toBe(urlFor("supabase", b));
  });

  it("ignores the order of list values so cache keys stay stable", () => {
    expect(urlFor("neon", { readOnly: false, categories: ["schema", "docs"] })).toBe(
      urlFor("neon", { readOnly: false, categories: ["docs", "schema"] }),
    );
    expect(urlFor("supabase", { readOnly: false, features: ["docs", "database"] })).toBe(
      urlFor("supabase", { readOnly: false, features: ["database", "docs"] }),
    );
  });

  it("orders params by declared rule order, not by selection order", () => {
    // Supabase declares features, then read_only, then project_ref.
    const url = urlFor("supabase", {
      projectRef: "p1",
      readOnly: true,
      features: ["docs"],
    });
    expect(url).toBe(
      "https://mcp.supabase.com/mcp?features=docs&read_only=true&project_ref=p1",
    );
  });
});

describe("buildScopedMcpUrl — immutability", () => {
  it("does not mutate the selection", () => {
    const categories = ["schema", "docs"];
    const selection: ProjectScopeSelection = {
      readOnly: true,
      projectRef: " p1 ",
      categories,
    };
    const snapshot = structuredClone(selection);

    buildScopedMcpUrl(provider("neon"), selection);

    expect(selection).toEqual(snapshot);
    // The caller's array itself must keep its original order.
    expect(categories).toEqual(["schema", "docs"]);
  });

  it("does not mutate the provider definition", () => {
    const definition = provider("sentry");
    const snapshot = structuredClone(definition);

    buildScopedMcpUrl(definition, {
      readOnly: true,
      orgSlug: "acme",
      projectSlug: "web-app",
      experimental: true,
    });

    expect(definition).toEqual(snapshot);
    expect(definition.mcpUrl).toBe("https://mcp.sentry.dev/mcp");
  });

  it("returns a fresh headers object per call", () => {
    const first = buildScopedMcpUrl(provider("github"), { readOnly: true });
    const second = buildScopedMcpUrl(provider("github"), { readOnly: true });
    expect(first.headers).not.toBe(second.headers);
    first.headers["X-Extra"] = "1";
    expect(second.headers).toEqual({ "X-MCP-Readonly": "true" });
  });
});

describe("buildScopedMcpUrl — irrelevant selection fields", () => {
  const everything: ProjectScopeSelection = {
    readOnly: true,
    projectRef: "p1",
    categories: ["schema"],
    features: ["database"],
    toolsets: ["issues"],
    orgSlug: "acme",
    projectSlug: "web-app",
    experimental: true,
  };

  it("ignores fields a provider does not declare a rule for", () => {
    // Stripe, Context7, Prisma and Cloudflare have no URL scoping at all.
    expect(buildScopedMcpUrl(provider("stripe"), everything)).toEqual({
      url: "https://mcp.stripe.com/",
      headers: {},
    });
    expect(buildScopedMcpUrl(provider("context7"), everything)).toEqual({
      url: "https://mcp.context7.com/mcp",
      headers: {},
    });
    expect(buildScopedMcpUrl(provider("prisma"), everything)).toEqual({
      url: "https://mcp.prisma.io/mcp",
      headers: {},
    });
    expect(buildScopedMcpUrl(provider("cloudflare"), everything)).toEqual({
      url: "https://mcp.cloudflare.com/mcp",
      headers: {},
    });
  });

  it("applies only the mechanisms each provider declares", () => {
    expect(buildScopedMcpUrl(provider("supabase"), everything)).toEqual({
      url: "https://mcp.supabase.com/mcp?features=database&read_only=true&project_ref=p1",
      headers: {},
    });
    expect(buildScopedMcpUrl(provider("neon"), everything)).toEqual({
      url: "https://mcp.neon.tech/mcp?category=schema&readonly=true&projectId=p1",
      headers: {},
    });
    expect(buildScopedMcpUrl(provider("sentry"), everything)).toEqual({
      url: "https://mcp.sentry.dev/mcp/acme/web-app?experimental=1",
      headers: {},
    });
    expect(buildScopedMcpUrl(provider("linear"), everything)).toEqual({
      url: "https://mcp.linear.app/mcp/readonly",
      headers: {},
    });
  });

  it("keeps every scoped URL on its provider's trusted hostname", () => {
    for (const definition of listProviders()) {
      const selection: ProjectScopeSelection = {
        ...everything,
        ...(definition.id === "sentry" ? {} : { projectSlug: undefined }),
        // GitLab declares its toolsets, so the shared "issues" would fail closed.
        ...(definition.id === "gitlab" ? { toolsets: ["core"] } : {}),
      };
      const { hostname } = new URL(buildScopedMcpUrl(definition, selection).url);
      expect(definition.trustedHostnames).toContain(hostname);
    }
  });
});

describe("buildScopedMcpUrl — GitLab fixed toolsets", () => {
  it("encodes toolsets only in the documented header, without claiming read-only enforcement", () => {
    expect(buildScopedMcpUrl(PROVIDERS.gitlab, {
      readOnly: true, toolsets: ["work_items", "core", "core"],
    })).toEqual({
      url: "https://gitlab.com/api/v4/mcp",
      headers: { "X-Gitlab-Enabled-Mcp-Server-Toolsets": "core,work_items" },
    });
    expect(PROVIDERS.gitlab.supportsReadOnly).toBe(false);
  });

  it("offers fixed published toolsets, preserving defaults without opting into Orbit", () => {
    const options = PROVIDERS.gitlab.scopeOptions?.toolsets;
    expect(options?.map((option) => option.id)).toEqual([
      "core", "merge_requests", "work_items", "repository", "ci",
      "duo_agent_platform", "wikis", "code_security",
    ]);
    const defaults = options?.filter((option) => option.enabledByDefault).map((option) => option.id);
    expect(defaults).toEqual([
      "core", "merge_requests", "work_items", "repository", "ci", "duo_agent_platform",
    ]);
    const scoped = buildScopedMcpUrl(PROVIDERS.gitlab, { readOnly: false, toolsets: defaults });
    expect(scoped.headers).toEqual({
      "X-Gitlab-Enabled-Mcp-Server-Toolsets": "ci,core,duo_agent_platform,merge_requests,repository,work_items",
    });
    // Omitting a selection leaves GitLab's documented defaults (no Orbit) intact.
    expect(buildScopedMcpUrl(PROVIDERS.gitlab, UNSCOPED)).toEqual({
      url: "https://gitlab.com/api/v4/mcp", headers: {},
    });
  });
});

describe("buildScopedMcpUrl — undeclared list values", () => {
  it("drops GitLab toolsets outside the declared options, such as all and orbit", () => {
    expect(buildScopedMcpUrl(PROVIDERS.gitlab, {
      readOnly: false, toolsets: ["orbit", "core", "all", "wikis"],
    }).headers).toEqual({ "X-Gitlab-Enabled-Mcp-Server-Toolsets": "core,wikis" });
  });

  it("drops undeclared query-param values for existing providers while keeping valid ones", () => {
    expect(urlFor("supabase", { readOnly: false, features: ["database", "everything", "docs"] }))
      .toBe(urlFor("supabase", { readOnly: false, features: ["database", "docs"] }));
    expect(urlFor("neon", { readOnly: false, categories: ["all", "schema"] }))
      .toBe("https://mcp.neon.tech/mcp?category=schema");
  });

  it("throws rather than widening to provider defaults when no selected value is declared", () => {
    for (const toolsets of [["bogus"], ["all", "orbit"], ["bogus", "  "]]) {
      expect(() => buildScopedMcpUrl(PROVIDERS.gitlab, { readOnly: false, toolsets }))
        .toThrow(/None of the selected "toolsets" are supported/);
    }
    expect(() => urlFor("supabase", { readOnly: false, features: ["everything"] }))
      .toThrow(/"features"/);
    // Empty and blank-only selections still mean "provider defaults".
    expect(buildScopedMcpUrl(PROVIDERS.gitlab, { readOnly: false, toolsets: [] }).headers).toEqual({});
    expect(buildScopedMcpUrl(PROVIDERS.gitlab, { readOnly: false, toolsets: ["  "] }).headers).toEqual({});
  });

  it("passes values through when a provider declares no options for the field", () => {
    expect(buildScopedMcpUrl(provider("github"), { readOnly: false, toolsets: ["repos"] }).headers)
      .toEqual({ "X-MCP-Toolsets": "repos" });
  });
});

it("defers WorkOS until its tool inventory is verified (#563)", () => {
  expect(getProvider("workos")).toBeUndefined();
  expect(getTrustedHostnames()).not.toContain("mcp.workos.com");
});
