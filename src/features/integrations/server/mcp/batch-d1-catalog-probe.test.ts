import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: (() => { throw new Error("transport not configured"); }) as () => unknown,
  transport: vi.fn(), mutation: vi.fn(),
  discover: vi.fn(), register: vi.fn(), authorize: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function (...args) {
    mocks.transport(...args);
    return mocks.createTransport();
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: mocks.discover, registerClient: mocks.register,
  startAuthorization: mocks.authorize, exchangeAuthorization: vi.fn(), refreshAuthorization: vi.fn(),
}));
vi.mock("../url-guard", () => ({
  assertSafeMcpUrl: async (url: string) => ({ ok: true, url: new URL(url) }),
}));
vi.mock("@/features/auth/server/require-user-id", () => ({
  requireUserId: async () => ({ userId: "alice" }),
}));
vi.mock("@/lib/convex-client", () => ({ convex: { mutation: mocks.mutation } }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }), CONNECT_RATE_LIMIT: {},
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, InitializeRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PROVIDERS } from "../../catalog";
import { resetSecretSealer } from "../crypto";
import { startOAuthFlow } from "../oauth/flow";
import { requiresApproval } from "./discover-tools";
import { probeMcpServer } from "./probe";

// Public OAuth metadata re-verified 2026-11-15; registration is mocked.
const CASES = [
  { id: "klaviyo", url: "https://mcp.klaviyo.com/mcp", issuer: "https://mcp.klaviyo.com", registration: "https://mcp.klaviyo.com/register" },
  { id: "granola", url: "https://mcp.granola.ai/mcp", issuer: "https://mcp-auth.granola.ai", registration: "https://mcp-auth.granola.ai/oauth2/register" },
  { id: "kit", url: "https://app.kit.com/mcp", issuer: "https://api.kit.com", registration: "https://app.kit.com/oauth/register" },
  { id: "mailerlite", url: "https://mcp.mailerlite.com/mcp", issuer: "https://mcp.mailerlite.com", registration: "https://mcp.mailerlite.com/register" },
  { id: "beehiiv", url: "https://mcp.beehiiv.com/mcp", issuer: "https://mcp.beehiiv.com", registration: "https://mcp.beehiiv.com/register" },
  { id: "prismic", url: "https://mcp.prismic.io/mcp", issuer: "https://mcp.prismic.io/", registration: "https://mcp.prismic.io/register" },
  { id: "gitbook", url: "https://mcp.gitbook.com/mcp", issuer: "https://oauth.gitbook.com", registration: "https://oauth.gitbook.com/register" },
  { id: "scite", url: "https://api.scite.ai/mcp", issuer: "https://api.scite.ai", registration: "https://api.scite.ai/mcp/oauth/register" },
  { id: "snyk-evo", url: "https://evo.snyk.io/mcp", issuer: "https://evo.snyk.io/mcp", registration: "https://evo.snyk.io/mcp/register" },
  { id: "axiom", url: "https://mcp.axiom.co/mcp", issuer: "https://authorization.axiom.co", registration: "https://authorization.axiom.co/oauth2/register" },
  { id: "fathom", url: "https://api.fathom.ai/mcp", issuer: "https://api.fathom.ai", registration: "https://api.fathom.ai/mcp/oauth/register" },
  { id: "help-scout", url: "https://mcp.helpscout.net/mcp", issuer: "https://mcp.helpscout.net", registration: "https://mcp.helpscout.net/oauth/register" },
  { id: "omnisend", url: "https://mcp.omnisend.com/mcp", issuer: "https://mcp.omnisend.com", registration: "https://app.omnisend.com/oauth2/register" },
  { id: "datocms", url: "https://mcp.datocms.com", issuer: "https://oauth.datocms.com", registration: "https://oauth.datocms.com/oauth/register" },
  { id: "circleback", url: "https://circleback.ai/api/mcp", issuer: "https://circleback.ai", registration: "https://circleback.ai/api/oauth/register" },
  { id: "getimg-ai", url: "https://getimg.ai/mcp", issuer: "https://getimg.ai", registration: "https://getimg.ai/api/auth/oauth2/register" },
] as const;
type Case = typeof CASES[number];

const SECRET = "batch-d1-credential-never-return";
const servers: Server[] = [];
function startServer(id: Case["id"], failure?: "initialize" | "list") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: id, version: "1.0.0" }, { capabilities: { tools: {} } });
  const reject = () => {
    throw new McpError(ErrorCode.InternalError, `HTTP ${failure === "list" ? 403 : 401} ${SECRET}`);
  };
  if (failure === "initialize") server.setRequestHandler(InitializeRequestSchema, reject);
  server.setRequestHandler(ListToolsRequestSchema, failure === "list" ? reject : async () => ({
    tools: ["get_account", "create_campaign", "run_agent", "export_data"].map((name) => ({
      name, inputSchema: { type: "object" as const, properties: {} }, annotations: { readOnlyHint: true },
    })),
  }));
  servers.push(server);
  void server.connect(serverSide);
  return clientSide;
}
const credentialHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${SECRET}` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal-test-key");
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
  vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
  resetSecretSealer();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  mocks.mutation.mockResolvedValue({ connectionId: "conn" });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetSecretSealer();
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe.each(CASES)("$id", (c) => {
  const provider = PROVIDERS[c.id];

  it("initializes and lists tools through the probe path with the registry's credential placement", async () => {
    expect(provider.authModes).toEqual(["oauth"]);
    expect(provider.mcpUrl).toBe(c.url);
    expect(provider.supportsReadOnly).toBe(false);
    expect(provider.readOnlyTools).toEqual([]);
    mocks.createTransport = () => startServer(c.id);
    const result = await probeMcpServer({
      url: provider.mcpUrl, headers: credentialHeaders(), trustedHosts: provider.trustedHostnames,
    });
    expect(result).toMatchObject({ ok: true, serverName: c.id });
    if (result.ok) expect(result.tools).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.transport.mock.calls[0][0].toString()).toBe(new URL(provider.mcpUrl).toString());
    expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual(credentialHeaders());
    const policy = { destructiveTools: provider.destructiveTools, readOnlyTools: provider.readOnlyTools, annotationsTrusted: true };
    for (const name of ["get_account", "create_campaign", "run_agent", "export_data", "unlisted_tool"]) {
      expect(requiresApproval(policy, { name, annotations: { readOnlyHint: true } }), name).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["initialize", "list"] as const)("reports a %s 401/403 as unauthorized without leaking or saving", async (phase) => {
    mocks.createTransport = () => startServer(c.id, phase);
    const result = await probeMcpServer({
      url: provider.mcpUrl, headers: credentialHeaders(), trustedHosts: provider.trustedHostnames,
    });
    expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe.each(CASES)("$id OAuth discovery and DCR", (c) => {
  const provider = PROVIDERS[c.id];
  const redirectUri = "https://app.example.test/api/integrations/oauth/callback";
  const metadata = { issuer: c.issuer, registration_endpoint: c.registration };

  beforeEach(() => {
    mocks.discover.mockResolvedValue({ authorizationServerUrl: c.issuer, authorizationServerMetadata: metadata });
    mocks.register.mockResolvedValue({ client_id: "mock-client", redirect_uris: [redirectUri] });
    mocks.authorize.mockResolvedValue({ authorizationUrl: new URL("https://example.test/authorize"), codeVerifier: "v" });
  });

  it("accepts the same-site issuer and binds DCR and authorization to this resource", async () => {
    expect(await startOAuthFlow({ provider, redirectUri })).toMatchObject({ ok: true, start: { issuer: c.issuer } });
    expect(mocks.discover).toHaveBeenCalledWith(provider.mcpUrl, expect.anything());
    expect(mocks.register).toHaveBeenCalledWith(c.issuer, expect.objectContaining({ metadata }));
    expect(mocks.authorize).toHaveBeenCalledWith(c.issuer, expect.objectContaining({ resource: new URL(provider.mcpUrl), scope: provider.oauthScopes?.join(" ") }));
  });

  it("rejects an unrelated authorization server before DCR", async () => {
    mocks.discover.mockResolvedValue({ authorizationServerUrl: "https://unrelated.example.test" });
    expect(await startOAuthFlow({ provider, redirectUri })).toMatchObject({ ok: false });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
