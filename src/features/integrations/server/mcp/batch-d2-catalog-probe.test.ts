import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: (() => { throw new Error("transport not configured"); }) as () => unknown,
  transport: vi.fn(), mutation: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function (...args) {
    mocks.transport(...args);
    return mocks.createTransport();
  }),
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
import { requiresApproval } from "./discover-tools";
import { probeMcpServer } from "./probe";

// Exact header schemes from official vendor setup documentation.
const CASES = [
  { id: "google-maps", auth: "api_key", header: "X-Goog-Api-Key", prefix: "" },
  { id: "perplexity", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "brevo", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "kit-docs", auth: "none" },
  { id: "better-stack", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "circleci", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "kagi", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "jina-ai", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "you-com", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "mintlify-docs", auth: "none" },
  { id: "pulumi", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "pulumi-brand", auth: "none" },
  { id: "supermetrics", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "readme", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "reka", auth: "api_key", header: "X-Reka-API-Key", prefix: "" },
  { id: "precip", auth: "api_key", header: "Authorization", prefix: "Bearer " },
  { id: "cleanvoice", auth: "api_key", header: "X-API-Key", prefix: "" },
] as const;
type Case = typeof CASES[number];

const SECRET = "batch-d2-credential-never-return";
const servers: Server[] = [];
function startServer(id: Case["id"], failure?: "initialize" | "list") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: id, version: "1.0.0" }, { capabilities: { tools: {} } });
  const reject = () => {
    throw new McpError(ErrorCode.InternalError, `HTTP ${failure === "list" ? 403 : 401} ${SECRET}`);
  };
  if (failure === "initialize") server.setRequestHandler(InitializeRequestSchema, reject);
  server.setRequestHandler(ListToolsRequestSchema, failure === "list" ? reject : async () => ({
    tools: [{ name: "unlisted_tool", inputSchema: { type: "object" as const, properties: {} }, annotations: { readOnlyHint: true } }],
  }));
  servers.push(server);
  void server.connect(serverSide);
  return clientSide;
}
const credentialHeaders = (c: Case): Record<string, string> =>
  c.auth === "none" ? {} : { [c.header]: `${c.prefix}${SECRET}` };

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
    expect(provider.supportsReadOnly).toBe(false);
    expect(provider.readOnlyTools).toEqual([]);
    mocks.createTransport = () => startServer(c.id);
    // Key and no-sign-in entries go through the real connect route.
    const response = await POST(new Request("http://localhost/api/integrations/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: c.id, ...(c.auth === "api_key" ? { apiKey: SECRET } : {}) }),
    }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
    expect(mocks.mutation.mock.calls[0][1]).toMatchObject({ authMode: c.auth, serverUrl: provider.mcpUrl });
    if (c.auth === "api_key") expect(provider.apiKey).toMatchObject({ header: c.header, valuePrefix: c.prefix });
    expect(mocks.transport.mock.calls[0][0].toString()).toBe(new URL(provider.mcpUrl).toString());
    expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual(credentialHeaders(c));
    const policy = { destructiveTools: provider.destructiveTools, readOnlyTools: provider.readOnlyTools, annotationsTrusted: true };
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
    const response = await POST(new Request("http://localhost/api/integrations/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: c.id, ...(c.auth === "api_key" ? { apiKey: SECRET } : {}) }),
    }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
