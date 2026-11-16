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
  {"id": "intercom", "url": "https://mcp.intercom.com/mcp", "issuer": "https://mcp.intercom.com", "registration": "https://mcp.intercom.com/register", "scopes": ["mcp", "operator"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "airtable", "url": "https://mcp.airtable.com/mcp", "issuer": "https://airtable.com/oauth2/v1", "registration": "https://airtable.com/oauth2/v1/register", "scopes": ["data.records:read", "data.records:write", "schema.bases:read", "schema.bases:write", "data.recordComments:read", "data.recordComments:write", "workspacesAndBases:read"], "methods": ["client_secret_basic", "none"]},
  {"id": "monday", "url": "https://mcp.monday.com/mcp", "issuer": "https://auth.monday.com/mcp", "registration": "https://auth.monday.com/oauth_ms/oauth/register", "scopes": [], "methods": ["client_secret_post", "client_secret_basic", "none"]},
  {"id": "clickup", "url": "https://mcp.clickup.com/mcp", "issuer": "https://mcp.clickup.com", "registration": "https://mcp.clickup.com/oauth/register", "scopes": ["read", "write"], "methods": ["none", "private_key_jwt", "client_secret_basic", "client_secret_post"]},
  {"id": "attio", "url": "https://mcp.attio.com/mcp", "issuer": "https://app.attio.com", "registration": "https://app.attio.com/oauth/register", "scopes": ["openid", "offline_access", "mcp"], "methods": ["none", "client_secret_post"]},
  {"id": "calendly", "url": "https://mcp.calendly.com", "issuer": "https://calendly.com/", "registration": "https://calendly.com/oauth/register", "scopes": ["mcp:notetaker:read", "mcp:scheduling:read", "mcp:scheduling:write"], "methods": ["none"]},
  {"id": "cal-com", "url": "https://mcp.cal.com/mcp", "issuer": "https://mcp.cal.com", "registration": "https://mcp.cal.com/oauth/register", "scopes": [], "methods": ["none"]},
  {"id": "todoist", "url": "https://ai.todoist.net/mcp", "issuer": "https://todoist.com", "registration": "https://todoist.com/oauth/register", "scopes": ["data:read_write"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "fireflies", "url": "https://api.fireflies.ai/mcp", "issuer": "https://api.fireflies.ai/", "registration": "https://api.fireflies.ai/register", "scopes": ["profile", "email", "meetings.upload"], "methods": ["client_secret_post", "none"]},
  {"id": "miro", "url": "https://mcp.miro.com/", "issuer": "https://mcp.miro.com/", "registration": "https://mcp.miro.com/register", "scopes": ["boards:read", "boards:write", "openid", "email"], "methods": ["client_secret_post", "client_secret_basic"]},
  {"id": "canva", "url": "https://mcp.canva.com/mcp", "issuer": "https://mcp.canva.com", "registration": "https://mcp.canva.com/register", "scopes": ["profile:read", "design:meta:read", "design:content:write", "design:content:read", "folder:read", "folder:write", "brandtemplate:content:read", "brandtemplate:meta:read"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "wix", "url": "https://mcp.wix.com/mcp", "issuer": "https://mcp.wix.com", "registration": "https://mcp.wix.com/register", "scopes": ["offline_access"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "wordpress-com", "url": "https://public-api.wordpress.com/wpcom/v2/mcp/v1", "issuer": "https://public-api.wordpress.com", "registration": "https://public-api.wordpress.com/oauth2-1/register", "scopes": ["global", "auth", "openid", "profile", "email", "users", "sites", "posts"], "methods": ["client_secret_basic", "client_secret_post", "none"]},
  {"id": "zapier", "url": "https://mcp.zapier.com/api/mcp/mcp", "issuer": "https://mcp.zapier.com", "registration": "https://mcp.zapier.com/api/v1/oauth/register", "scopes": ["openid", "profile", "email"], "methods": ["none", "client_secret_post", "client_secret_basic"]},
  {"id": "make", "url": "https://mcp.make.com/", "issuer": "https://www.make.com/mcp", "registration": "https://www.make.com/oauth/v2/register/mcp", "scopes": [], "methods": ["client_secret_post"]},
  {"id": "customer-io", "url": "https://mcp.customer.io/mcp", "issuer": "https://mcp.customer.io", "registration": "https://mcp.customer.io/oauth2/register", "scopes": ["configure", "read", "read:sensitive", "write", "write:live"], "methods": ["client_secret_post", "none"]},
] as const;
const SECRET = "batch-a-test-token-never-return";
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

describe.each(CASES)("$id batch A (no vendor network)", (fixture) => {
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
    const metadata = { issuer: fixture.issuer, registration_endpoint: fixture.registration, token_endpoint_auth_methods_supported: fixture.methods, scopes_supported: fixture.scopes };
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

it("trusts only Todoist's exact cross-site authorization origin", () => {
  expect(getProvider("todoist")!.trustedAuthorizationServerOrigins).toEqual(["https://todoist.com"]);
});
