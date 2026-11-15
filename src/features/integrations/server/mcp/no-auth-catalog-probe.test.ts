import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
vi.mock("../crypto", async (original) => ({
  ...(await original<object>()),
  getSecretSealer: () => { throw new Error("No credential store for public docs"); },
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, InitializeRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { POST } from "@/app/api/integrations/connect/route";
import { PROVIDERS } from "../../catalog";
import { resolveMcpServers } from "./resolve-servers";
import { requiresApproval } from "./discover-tools";

const ids = ["microsoft-learn", "cloudflare-docs"] as const;
const servers: Server[] = [];
function startServer(id: typeof ids[number], failure?: "initialize" | "list") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: id, version: "1.0.0" }, { capabilities: { tools: {} } });
  const reject = () => { throw new McpError(ErrorCode.InternalError, "HTTP 401 private-response-marker"); };
  if (failure === "initialize") server.setRequestHandler(InitializeRequestSchema, reject);
  server.setRequestHandler(ListToolsRequestSchema, failure === "list" ? reject : async () => ({
    tools: (PROVIDERS[id].readOnlyTools ?? []).map((name) => ({
      name, inputSchema: { type: "object" as const, properties: {} },
      annotations: { readOnlyHint: true },
    })),
  }));
  servers.push(server);
  void server.connect(serverSide);
  return clientSide;
}
function connect(providerId: string, extra = {}) {
  return POST(new Request("http://localhost/api/integrations/connect", {
    method: "POST", body: JSON.stringify({ providerId, ...extra }),
    headers: { "Content-Type": "application/json" },
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal-test-key");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  mocks.mutation.mockResolvedValue({ connectionId: "conn" });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it.each(ids)("%s connects and resolves without a credential store or Authorization", async (id) => {
  const provider = PROVIDERS[id];
  mocks.createTransport = () => startServer(id);
  const response = await connect(id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, toolCount: provider.readOnlyTools?.length });
  const saved = mocks.mutation.mock.calls[0][1];
  expect(saved).toMatchObject({
    authMode: "none", serverUrl: provider.mcpUrl, credentialRef: "",
    kekProvider: "", kekKeyId: "", wrappedDek: "", ciphertext: "", iv: "", authTag: "",
  });
  expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual({});
  const result = await resolveMcpServers([{
    connection: { _id: "conn", ...saved },
    link: { _id: "link", readOnly: true, providerScope: {}, writeApproved: false },
  }]);
  expect(result.problems).toEqual([]);
  const runtime = result.servers[0];
  expect(runtime.headers).toMatchInlineSnapshot(`{}`);
  expect(runtime.knownSecrets).toEqual([]);
  expect(runtime.url).toBe(provider.mcpUrl);
  expect(runtime.trustedHostnames).toEqual(provider.trustedHostnames);
  for (const name of provider.readOnlyTools ?? []) {
    expect(requiresApproval(runtime, { name, annotations: { readOnlyHint: true } })).toBe(false);
  }
  expect(requiresApproval(runtime, { name: "unlisted_tool", annotations: { readOnlyHint: true } })).toBe(true);
  const tampered = await resolveMcpServers([{
    connection: { _id: "conn", ...saved, serverUrl: "https://example.com/mcp" },
    link: { _id: "link", readOnly: true, providerScope: {}, writeApproved: false },
  }]);
  expect(tampered.servers).toEqual([]);
  expect(tampered.problems).toHaveLength(1);
});

it.each(ids.flatMap((id) => ["initialize", "list"].map((failure) => [id, failure] as const)))(
  "%s does not persist after %s fails", async (id, failure) => {
    mocks.createTransport = () => startServer(id, failure as "initialize" | "list");
    const response = await connect(id);
    expect(response.ok).toBe(false);
    expect(JSON.stringify(await response.json())).not.toContain("private-response-marker");
    expect(mocks.mutation).not.toHaveBeenCalled();
  },
);
it.each(ids)("%s rejects custom URLs and credentials before probing", async (id) => {
  for (const extra of [{ serverUrl: "https://example.com/mcp" }, { apiKey: "unwanted" }]) {
    expect((await connect(id, extra)).status).toBe(400);
  }
  expect(mocks.transport).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
