// Pre-registered (confidential) OAuth client, #539. The real SDK runs against a
// stubbed authorization server so the token request headers and body are the
// ones that would go on the wire.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderDefinition } from "../../types";

const net = vi.hoisted(() => ({
  requests: [] as { url: string; headers: Headers; body: string }[],
  asMetadata: {} as Record<string, unknown>,
  tokenResponse: undefined as Response | undefined,
}));
vi.mock("../mcp/guarded-fetch", () => ({
  createGuardedFetch: () => async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    net.requests.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/.well-known/oauth-protected-resource")) {
      const isGithub = url.includes("//api.github");
      return json({
        resource: `${new URL(url).origin}/mcp${isGithub ? "/" : ""}`,
        authorization_servers: [isGithub ? "https://github.com/login/oauth" : "https://auth.example.com"],
      });
    }
    if (url.includes("/.well-known/oauth-authorization-server")) return json(net.asMetadata);
    if (url.includes("/.well-known/")) return json({}, 404);
    if (url.endsWith("/register")) return json({ client_id: "dcr-client", redirect_uris: [redirectUri] }, 201);
    if (url.includes("token")) return net.tokenResponse ?? json({ access_token: "gho_access", token_type: "bearer" });
    return json({}, 404);
  },
}));

import { PROVIDERS } from "../../catalog";
import { completeOAuthFlow, refreshOAuthTokens, startOAuthFlow } from "./flow";

const redirectUri = "https://app.example.test/api/integrations/oauth/callback";
const SECRET = "test-secret-value-not-real";
const github = PROVIDERS.github;
// GitHub's live metadata, 2026-11-15: no token_endpoint_auth_methods_supported.
const githubMetadata = {
  issuer: "https://github.com/login/oauth",
  authorization_endpoint: "https://github.com/login/oauth/authorize",
  token_endpoint: "https://github.com/login/oauth/access_token",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};
const logs = vi.hoisted(() => [] as unknown[][]);

beforeEach(() => {
  net.requests = [];
  net.tokenResponse = undefined;
  net.asMetadata = githubMetadata;
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
  }
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "Iv1.test-client");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const tokenRequest = () => net.requests.find((r) => r.url === githubMetadata.token_endpoint)!;
const expectNoSecretLeak = (...values: unknown[]) => {
  for (const value of [...values, logs]) expect(JSON.stringify(value) ?? "").not.toContain(SECRET);
};

async function connect(provider: ProviderDefinition = github) {
  const started = await startOAuthFlow({ provider, redirectUri });
  if (!started.ok) throw new Error(started.error);
  const completed = await completeOAuthFlow({
    provider,
    authorizationServerUrl: started.start.authorizationServerUrl,
    authorizationServerMetadata: started.start.authorizationServerMetadata,
    authorizationCode: "code-123",
    codeVerifier: started.start.codeVerifier,
    redirectUri,
    // Round-trips through the sealed flow state as JSON in production.
    clientInformation: JSON.parse(JSON.stringify(started.start.clientInformation)),
  });
  return { start: started.start, completed };
}

describe("pre-registered OAuth client", () => {
  it("skips DCR and keeps state and PKCE, using the configured client id", async () => {
    const { start, completed } = await connect();
    expect(completed).toMatchObject({ ok: true, tokens: { access_token: "gho_access" } });
    expect(net.requests.some((r) => r.url.endsWith("/register"))).toBe(false);

    const authorize = new URL(start.authorizationUrl);
    expect(authorize.origin + authorize.pathname).toBe(githubMetadata.authorization_endpoint);
    expect(authorize.searchParams.get("client_id")).toBe("Iv1.test-client");
    expect(authorize.searchParams.get("state")).toBe(start.state);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(authorize.searchParams.get("scope")).toBe("repo read:org");
    expect(start.issuer).toBe(githubMetadata.issuer);
    expect(start.clientInformation).not.toHaveProperty("client_secret");

    const body = new URLSearchParams(tokenRequest().body);
    expect(body.get("code_verifier")).toBe(start.codeVerifier);
    expect(body.get("grant_type")).toBe("authorization_code");
    expectNoSecretLeak(start, completed);
  });

  it("sends client_secret_post when the server advertises no method", async () => {
    await connect();
    const { headers, body } = tokenRequest();
    expect(headers.get("Authorization")).toBeNull();
    const params = new URLSearchParams(body);
    expect(params.get("client_id")).toBe("Iv1.test-client");
    expect(params.get("client_secret")).toBe(SECRET);
  });

  it("sends client_secret_post when only that is advertised", async () => {
    net.asMetadata = { ...githubMetadata, token_endpoint_auth_methods_supported: ["client_secret_post"] };
    await connect();
    expect(tokenRequest().headers.get("Authorization")).toBeNull();
    expect(new URLSearchParams(tokenRequest().body).get("client_secret")).toBe(SECRET);
  });

  it("prefers client_secret_basic when both are advertised", async () => {
    net.asMetadata = {
      ...githubMetadata,
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    };
    await connect();
    const { headers, body } = tokenRequest();
    expect(headers.get("Authorization")).toBe(`Basic ${btoa(`Iv1.test-client:${SECRET}`)}`);
    expect(new URLSearchParams(body).has("client_secret")).toBe(false);
  });

  it("re-presents the secret on refresh without storing it", async () => {
    const { start } = await connect();
    net.requests = [];
    const refreshed = await refreshOAuthTokens({
      provider: github,
      authorizationServerUrl: start.authorizationServerUrl,
      authorizationServerMetadata: start.authorizationServerMetadata,
      refreshToken: "refresh-123",
      clientInformation: start.clientInformation,
    });
    expect(refreshed.ok).toBe(true);
    expect(new URLSearchParams(tokenRequest().body).get("client_secret")).toBe(SECRET);
    expectNoSecretLeak(refreshed);
  });

  it("redacts the secret from a token error that echoes it", async () => {
    net.tokenResponse = new Response(
      JSON.stringify({ error: "invalid_client", error_description: `bad secret ${SECRET}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const { completed } = await connect();
    expect(completed).toMatchObject({ ok: false, error: expect.stringContaining("[redacted]") });
    expectNoSecretLeak(completed);
  });

  it.each(["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"])(
    "refuses to start without %s and makes no request",
    async (name) => {
      vi.stubEnv(name, "");
      expect(await startOAuthFlow({ provider: github, redirectUri })).toMatchObject({
        ok: false, error: expect.stringContaining("not configured"),
      });
      expect(net.requests).toEqual([]);
    },
  );

  it("refuses the exchange when the secret is removed mid-flow", async () => {
    const started = await startOAuthFlow({ provider: github, redirectUri });
    if (!started.ok) throw new Error(started.error);
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "");
    const completed = await completeOAuthFlow({
      provider: github,
      authorizationServerUrl: started.start.authorizationServerUrl,
      authorizationServerMetadata: started.start.authorizationServerMetadata,
      authorizationCode: "code-123",
      codeVerifier: started.start.codeVerifier,
      redirectUri,
      clientInformation: started.start.clientInformation,
    });
    expect(completed).toMatchObject({ ok: false, error: expect.stringContaining("not configured") });
    expect(net.requests.some((r) => r.url === githubMetadata.token_endpoint)).toBe(false);
  });
});

describe("dynamic client registration (unchanged)", () => {
  const dcrProvider: ProviderDefinition = {
    id: "example",
    displayName: "Example",
    description: "DCR provider for regression tests.",
    category: "Dev tools",
    logo: "/integrations/github.svg",
    mcpUrl: "https://mcp.example.com/mcp",
    authModes: ["oauth"],
    trustedHostnames: ["mcp.example.com"],
    trustedAuthorizationServerOrigins: ["https://auth.example.com"],
    supportsReadOnly: false,
    scope: { queryParams: [], headers: [] },
    destructiveTools: [],
  };

  it("registers a public client and exchanges the code without a secret", async () => {
    net.asMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    const { start, completed } = await connect(dcrProvider);
    expect(completed.ok).toBe(true);
    expect(start.clientInformation.client_id).toBe("dcr-client");

    const register = net.requests.find((r) => r.url.endsWith("/register"))!;
    expect(JSON.parse(register.body)).toMatchInlineSnapshot(`
      {
        "client_name": "Codenaya",
        "client_uri": "https://codenaya.com",
        "grant_types": [
          "authorization_code",
          "refresh_token",
        ],
        "redirect_uris": [
          "https://app.example.test/api/integrations/oauth/callback",
        ],
        "response_types": [
          "code",
        ],
        "token_endpoint_auth_method": "none",
      }
    `);
    const token = net.requests.find((r) => r.url === "https://auth.example.com/token")!;
    expect(token.headers.get("Authorization")).toBeNull();
    const params = Object.fromEntries(new URLSearchParams(token.body));
    expect({ ...params, code_verifier: "<verifier>" }).toMatchInlineSnapshot(`
      {
        "client_id": "dcr-client",
        "code": "code-123",
        "code_verifier": "<verifier>",
        "grant_type": "authorization_code",
        "redirect_uri": "https://app.example.test/api/integrations/oauth/callback",
        "resource": "https://mcp.example.com/mcp",
      }
    `);
  });
});
