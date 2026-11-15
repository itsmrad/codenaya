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
import { POST } from "@/app/api/integrations/connect/route";
import { PROVIDERS } from "../../catalog";
import { resetSecretSealer } from "../crypto";
import { startOAuthFlow } from "../oauth/flow";
import { requiresApproval } from "./discover-tools";
import { probeMcpServer } from "./probe";

// Authorization servers from the public protected-resource metadata, probed 2026-11-15.
const DESCOPE_AS = "https://api.descope.com/v1/apps/agentic/P2DA3QqyF3N3BlmIqn1nr0LMFhrw/MS3AebdnI1nLELsiorZz77KmIleWt";
const CASES = [
  { id: "cloudflare-browser", auth: "oauth", issuer: "https://browser.mcp.cloudflare.com" },
  { id: "descope", auth: "oauth", issuer: DESCOPE_AS },
  { id: "wandb", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "langfuse", auth: "none" },
] as const;
type Case = typeof CASES[number];

const SECRET = "batch-c-credential-never-return";
const servers: Server[] = [];
function startServer(id: Case["id"], failure?: "initialize" | "list") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: id, version: "1.0.0" }, { capabilities: { tools: {} } });
  const reject = () => {
    throw new McpError(ErrorCode.InternalError, `HTTP ${failure === "list" ? 403 : 401} ${SECRET}`);
  };
  if (failure === "initialize") server.setRequestHandler(InitializeRequestSchema, reject);
  server.setRequestHandler(ListToolsRequestSchema, failure === "list" ? reject : async () => ({
    tools: (PROVIDERS[id].readOnlyTools ?? []).map((name) => ({
      name, inputSchema: { type: "object" as const, properties: {} }, annotations: { readOnlyHint: true },
    })),
  }));
  servers.push(server);
  void server.connect(serverSide);
  return clientSide;
}
const credentialHeaders = (c: Case): Record<string, string> =>
  c.auth === "none" ? {} : c.auth === "api_key" ? { [c.header]: `${c.prefix}${SECRET}` } : { Authorization: `Bearer ${SECRET}` };

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

describe.each(CASES)("$id ($auth)", (c) => {
  const provider = PROVIDERS[c.id];

  it("initializes and lists tools through the probe path with the registry's credential placement", async () => {
    expect(provider.authModes).toEqual([c.auth]);
    mocks.createTransport = () => startServer(c.id);
    if (c.auth === "oauth") {
      const result = await probeMcpServer({
        url: provider.mcpUrl, headers: credentialHeaders(c), trustedHosts: provider.trustedHostnames,
      });
      expect(result).toMatchObject({ ok: true, serverName: c.id });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } else {
      // Key and no-sign-in entries go through the real connect route.
      const response = await POST(new Request("http://localhost/api/integrations/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: c.id, ...(c.auth === "api_key" ? { apiKey: SECRET } : {}) }),
      }));
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain(SECRET);
      expect(mocks.mutation.mock.calls[0][1]).toMatchObject({ authMode: c.auth, serverUrl: provider.mcpUrl });
      if (c.auth === "api_key") expect(provider.apiKey).toMatchObject({ header: c.header, valuePrefix: c.prefix });
    }
    expect(mocks.transport.mock.calls[0][0].toString()).toBe(new URL(provider.mcpUrl).toString());
    expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual(credentialHeaders(c));
    const policy = { destructiveTools: provider.destructiveTools, readOnlyTools: provider.readOnlyTools, annotationsTrusted: true };
    for (const name of provider.readOnlyTools ?? []) {
      expect(requiresApproval(policy, { name, annotations: { readOnlyHint: true } }), name).toBe(false);
    }
    for (const name of [...provider.destructiveTools, "unlisted_tool"]) {
      expect(requiresApproval(policy, { name, annotations: { readOnlyHint: true } }), name).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["initialize", "list"] as const)("reports a %s 401/403 as unauthorized without leaking or saving", async (phase) => {
    mocks.createTransport = () => startServer(c.id, phase);
    const result = await probeMcpServer({
      url: provider.mcpUrl, headers: credentialHeaders(c), trustedHosts: provider.trustedHostnames,
    });
    expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe.each(CASES.filter((c): c is Extract<Case, { auth: "oauth" }> => c.auth === "oauth"))("$id OAuth discovery and DCR", (c) => {
  const provider = PROVIDERS[c.id];
  const redirectUri = "https://app.example.test/api/integrations/oauth/callback";
  const metadata = { issuer: c.issuer, registration_endpoint: `${c.issuer}/register` };

  beforeEach(() => {
    mocks.discover.mockResolvedValue({ authorizationServerUrl: c.issuer, authorizationServerMetadata: metadata });
    mocks.register.mockResolvedValue({ client_id: "mock-client", redirect_uris: [redirectUri] });
    mocks.authorize.mockResolvedValue({ authorizationUrl: new URL("https://example.test/authorize"), codeVerifier: "v" });
  });

  it("accepts the same-site issuer and binds DCR and authorization to this resource", async () => {
    expect(await startOAuthFlow({ provider, redirectUri })).toMatchObject({ ok: true, start: { issuer: c.issuer } });
    expect(mocks.discover).toHaveBeenCalledWith(provider.mcpUrl, expect.anything());
    expect(mocks.register).toHaveBeenCalledWith(c.issuer, expect.objectContaining({ metadata }));
    expect(mocks.authorize).toHaveBeenCalledWith(c.issuer, expect.objectContaining({ resource: new URL(provider.mcpUrl) }));
  });

  it("rejects an unrelated authorization server before DCR", async () => {
    mocks.discover.mockResolvedValue({ authorizationServerUrl: "https://unrelated.example.test" });
    expect(await startOAuthFlow({ provider, redirectUri })).toMatchObject({ ok: false });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
