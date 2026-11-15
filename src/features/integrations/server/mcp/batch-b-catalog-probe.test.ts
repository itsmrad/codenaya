import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: (() => { throw new Error("transport not configured"); }) as () => unknown,
  transport: vi.fn(), safeUrl: vi.fn(), discover: vi.fn(), register: vi.fn(), authorize: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function (...args) {
    mocks.transport(...args);
    return mocks.createTransport();
  }),
}));
vi.mock("../url-guard", () => ({ assertSafeMcpUrl: mocks.safeUrl }));
vi.mock("./guarded-fetch", () => ({ createGuardedFetch: () => mocks.fetch }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: mocks.discover, registerClient: mocks.register,
  startAuthorization: mocks.authorize, exchangeAuthorization: vi.fn(), refreshAuthorization: vi.fn(),
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, InitializeRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProvider } from "../../catalog";
import { startOAuthFlow } from "../oauth/flow";
import { requiresApproval } from "./discover-tools";
import { probeMcpServer } from "./probe";

// Verified public OAuth metadata, 2026-11-15; no authenticated vendor calls.
const CASES = [
  {"id": "datadog", "url": "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", "issuer": "https://mcp.datadoghq.com/v1/mcp", "registration": "https://app.datadoghq.com/api/v2/oauth2/register", "scopes": ["mcp_all"], "methods": ["none"]},
  {"id": "honeycomb", "url": "https://mcp.honeycomb.io/mcp", "issuer": "https://ui.honeycomb.io", "registration": "https://ui.honeycomb.io/oauth/register", "scopes": ["mcp:read", "mcp:write"], "methods": ["none", "client_secret_basic", "client_secret_post"]},
  {"id": "grafana-cloud", "url": "https://mcp.grafana.com/mcp", "issuer": "https://mcp.grafana.com/mcp", "registration": "https://mcp.grafana.com/mcp/oauth/register", "scopes": ["grafana:read", "grafana:query", "grafana:write"], "methods": ["none", "client_secret_basic", "client_secret_post"]},
  {"id": "new-relic", "url": "https://mcp.newrelic.com/mcp/", "issuer": "https://oauth2.service.newrelic.com", "registration": "https://dcr.service.newrelic.com/register", "scopes": ["observability:read", "offline", "offline_access", "dashboards:modify", "alerts:modify"], "methods": ["client_secret_post", "client_secret_basic", "private_key_jwt", "none"]},
  {"id": "launchdarkly", "url": "https://mcp.launchdarkly.com/mcp", "issuer": "https://app.launchdarkly.com", "registration": "https://app.launchdarkly.com/trust/oauth/register/dcr", "scopes": ["reader", "writer", "observability", "offline_access"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "postman", "url": "https://mcp.postman.com/mcp", "issuer": "https://mcp.postman.com", "registration": "https://mcp.postman.com/register", "scopes": [], "methods": ["none", "client_secret_basic", "client_secret_post"]},
  {"id": "heroku", "url": "https://mcp.heroku.com/mcp", "issuer": "https://mcp.heroku.com", "registration": "https://mcp.heroku.com/reg", "scopes": ["openid", "offline_access"], "methods": null},
  {"id": "sourcegraph", "url": "https://sourcegraph.com/.api/mcp", "issuer": "https://sourcegraph.com", "registration": "https://sourcegraph.com/.auth/idp/oauth/register", "scopes": ["openid", "profile", "email", "offline_access", "mcp"], "methods": ["client_secret_post", "none"]},
  {"id": "clickhouse", "url": "https://mcp.clickhouse.cloud/mcp", "issuer": "https://mcp.clickhouse.cloud", "registration": "https://mcp.clickhouse.cloud/register", "scopes": ["mcp:access", "openid", "profile", "email"], "methods": ["none"]},
  {"id": "algolia", "url": "https://mcp.algolia.com/mcp", "issuer": "https://dashboard.algolia.com", "registration": "https://dashboard.algolia.com/2/oauth/register", "scopes": ["public"], "methods": ["none"]},
  {"id": "apify", "url": "https://mcp.apify.com/", "issuer": "https://console-backend.apify.com", "registration": "https://console-backend.apify.com/oauth/apps", "scopes": ["full_api_access"], "methods": ["client_secret_basic", "client_secret_post", "none", "private_key_jwt"]},
  {"id": "bright-data", "url": "https://mcp.brightdata.com/mcp", "issuer": "https://brightdata.com", "registration": "https://brightdata.com/users/auth/mcp/register", "scopes": ["mcp"], "methods": ["none"]},
  {"id": "parallel", "url": "https://search-mcp.parallel.ai/mcp", "issuer": "https://platform.parallel.ai", "registration": "https://platform.parallel.ai/getKeys/register", "scopes": ["key:read"], "methods": ["none"]},
  {"id": "fal", "url": "https://mcp.fal.ai/mcp", "issuer": "https://mcp.fal.ai", "registration": "https://authkit.fal.ai/oauth2/register", "scopes": ["openid", "profile", "email", "offline_access"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "replicate", "url": "https://mcp.replicate.com/mcp", "issuer": "https://mcp.replicate.com/", "registration": "https://mcp.replicate.com/register", "scopes": [], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "mapbox", "url": "https://mcp.mapbox.com/mcp", "issuer": "https://mcp.mapbox.com", "registration": "https://api.mapbox.com/oauth/register?scope=styles%3Atiles%20styles%3Aread%20fonts%3Aread%20datasets%3Aread%20tokens%3Aread%20user-feedback%3Aread%20user-feedback%3Awrite", "scopes": ["styles:tiles", "styles:read", "fonts:read", "datasets:read", "tokens:read", "user-feedback:read", "user-feedback:write"], "methods": ["client_secret_post", "client_secret_basic", "none"]},
  {"id": "mux", "url": "https://mcp.mux.com", "issuer": "https://auth.mux.com", "registration": "https://auth.mux.com/oauth2/register", "scopes": ["email", "offline_access", "openid", "profile"], "methods": ["none", "client_secret_post", "client_secret_basic"]},
] as const;
const SECRET = "batch-b-test-token-never-return";
const redirectUri = "https://app.example.test/api/integrations/oauth/callback";
const servers: Server[] = [];
let failure: "initialize" | "list" | undefined;

function startServer(id: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: id, version: "1.0.0" }, { capabilities: { tools: {} } });
  const reject = () => { throw new McpError(ErrorCode.InternalError, `HTTP ${failure === "list" ? 403 : 401} ${SECRET}`); };
  if (failure === "initialize") server.setRequestHandler(InitializeRequestSchema, reject);
  server.setRequestHandler(ListToolsRequestSchema, failure === "list" ? reject : async () => ({
    tools: [{ name: "unlisted_tool", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
  }));
  servers.push(server);
  void server.connect(serverSide);
  return clientSide;
}

beforeEach(() => {
  vi.resetAllMocks();
  failure = undefined;
  mocks.safeUrl.mockImplementation(async (url: string) => ({ ok: true, url: new URL(url) }));
  mocks.fetch.mockImplementation(() => { throw new Error("Unexpected vendor request"); });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.register.mockResolvedValue({ client_id: "mock-client", redirect_uris: [redirectUri] });
  mocks.authorize.mockResolvedValue({ authorizationUrl: new URL("https://example.test/authorize"), codeVerifier: "mock-verifier" });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.unstubAllGlobals();
});

describe.each(CASES)("$id batch B (no vendor network)", (fixture) => {
  const provider = getProvider(fixture.id)!;

  it("initializes, lists tools, and keeps unverified tools gated", async () => {
    mocks.createTransport = () => startServer(fixture.id);
    expect(provider.mcpUrl).toBe(fixture.url);
    expect(provider.authModes).toEqual(["oauth"]);
    expect(provider.supportsReadOnly).toBe(false);
    expect(provider.destructiveTools).toEqual([]);
    expect(provider.readOnlyTools).toEqual([]);
    const result = await probeMcpServer({ url: provider.mcpUrl, headers: { Authorization: `Bearer ${SECRET}` }, trustedHosts: provider.trustedHostnames });
    expect(result).toMatchObject({ ok: true, serverName: fixture.id, tools: [{ name: "unlisted_tool" }] });
    expect(mocks.transport.mock.calls[0][0].toString()).toBe(new URL(fixture.url).toString());
    expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(mocks.safeUrl).toHaveBeenCalledWith(fixture.url, { trustedHosts: provider.trustedHostnames });
    for (const name of ["unlisted_tool", "get_api_token", "export_data", "run_agent"]) {
      expect(requiresApproval({ ...provider, readOnlyEnforced: false, annotationsTrusted: true }, { name, annotations: { readOnlyHint: true } })).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["initialize", "list"] as const)("redacts the token on %s 401/403 failure", async (phase) => {
    failure = phase;
    mocks.createTransport = () => startServer(fixture.id);
    const result = await probeMcpServer({ url: fixture.url, headers: { Authorization: `Bearer ${SECRET}` }, trustedHosts: provider.trustedHostnames });
    expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("discovers the verified issuer and registers for this MCP resource", async () => {
    const metadata = { issuer: fixture.issuer, registration_endpoint: fixture.registration, token_endpoint_auth_methods_supported: fixture.methods ?? undefined, scopes_supported: fixture.scopes };
    mocks.discover.mockResolvedValue({ authorizationServerUrl: fixture.issuer, authorizationServerMetadata: metadata });
    expect(await startOAuthFlow({ provider, redirectUri })).toMatchObject({ ok: true, start: { authorizationServerUrl: fixture.issuer, issuer: fixture.issuer } });
    const scope = fixture.scopes.length ? fixture.scopes.join(" ") : undefined;
    expect(mocks.discover).toHaveBeenCalledWith(fixture.url, { fetchFn: mocks.fetch });
    expect(mocks.register).toHaveBeenCalledWith(fixture.issuer, expect.objectContaining({ metadata, scope, fetchFn: mocks.fetch, clientMetadata: expect.objectContaining({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) }));
    expect(mocks.authorize).toHaveBeenCalledWith(fixture.issuer, expect.objectContaining({ metadata, scope, resource: new URL(fixture.url), redirectUrl: redirectUri }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unrelated issuer before DCR", async () => {
    mocks.discover.mockResolvedValue({ authorizationServerUrl: "https://unrelated.example.test" });
    expect(await startOAuthFlow({ provider, redirectUri })).toMatchObject({ ok: false, error: expect.stringMatching(/authorization server/i) });
    expect(mocks.register).not.toHaveBeenCalled();
  });
});

