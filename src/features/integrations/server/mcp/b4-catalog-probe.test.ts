import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: (() => { throw new Error("transport not configured"); }) as () => unknown,
  transport: vi.fn(),
  safeUrl: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function (...args) {
    mocks.transport(...args);
    return mocks.createTransport();
  }),
}));
vi.mock("../url-guard", () => ({ assertSafeMcpUrl: mocks.safeUrl }));
vi.mock("@/features/auth/server/require-user-id", () => ({
  requireUserId: async () => ({ userId: "alice" }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  CONNECT_RATE_LIMIT: {},
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode, InitializeRequestSchema, ListToolsRequestSchema, McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { POST } from "@/app/api/integrations/connect/route";
import { PROVIDERS } from "../../catalog";
import { getSecretSealer, resetSecretSealer, secretContext } from "../crypto";
import { probeMcpServer } from "./probe";
import { resolveMcpServers, type ProjectLinkRecord } from "./resolve-servers";
import { requiresApproval } from "./discover-tools";

interface Fixture {
  id: "webflow" | "netlify" | "railway";
  url: string;
  scopedUrl: string;
  read: string;
}

const CASES: Fixture[] = [
  {
    id: "webflow", url: "https://mcp.webflow.com/mcp",
    scopedUrl: "https://mcp.webflow.com/mcp", read: "webflow_guide_tool",
  },
  {
    id: "netlify", url: "https://mcp.netlify.com/mcp",
    scopedUrl: "https://mcp.netlify.com/mcp", read: "netlify-open-deployments",
  },
  {
    id: "railway", url: "https://mcp.railway.com",
    scopedUrl: "https://mcp.railway.com/", read: "whoami",
  },
];

const SECRET = "b4-test-credential-never-return";
const servers: Server[] = [];
let failure: "initialize" | "list" | undefined;

function startServer(fixture: Fixture) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: fixture.id, version: "1.0.0" }, { capabilities: { tools: {} } },
  );
  const reject = () => { throw new McpError(ErrorCode.InternalError, `HTTP ${failure === "list" ? 403 : 401} ${SECRET}`); };
  if (failure === "initialize") server.setRequestHandler(InitializeRequestSchema, reject);
  server.setRequestHandler(ListToolsRequestSchema, failure === "list" ? reject : async () => ({
    tools: [{
      name: fixture.read, description: "Mock vendor read",
      inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
    }],
  }));
  servers.push(server);
  void server.connect(serverSide);
  return clientSide;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-internal-key");
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
  vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
  resetSecretSealer();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  mocks.safeUrl.mockImplementation(async (url: string) => ({ ok: true, url: new URL(url) }));
  mocks.mutation.mockResolvedValue({ connectionId: "conn" });
  failure = undefined;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetSecretSealer();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(CASES)("$id SDK handshake and tools/list (no vendor network)", (fixture) => {
  it("probes an OAuth credential and composes the runtime target without leaking the token", async () => {
    const provider = PROVIDERS[fixture.id];
    mocks.createTransport = () => startServer(fixture);
    expect(provider.authModes).toEqual(["oauth"]);
    const result = await probeMcpServer({
      url: provider.mcpUrl, headers: { Authorization: `Bearer ${SECRET}` },
      trustedHosts: provider.trustedHostnames,
    });
    expect(result).toMatchObject({
      ok: true, serverName: fixture.id, tools: [{ name: fixture.read }],
    });
    expect(mocks.transport.mock.calls[0][0].toString()).toBe(new URL(fixture.url).toString());
    expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(mocks.safeUrl).toHaveBeenCalledWith(provider.mcpUrl, { trustedHosts: provider.trustedHostnames });
    expect(JSON.stringify(result)).not.toContain(SECRET);

    const sealed = await getSecretSealer().seal(
      JSON.stringify({ type: "oauth", accessToken: SECRET }),
      secretContext("userConnections", "ref", "credential"),
    );
    const link: ProjectLinkRecord = {
      _id: "link", readOnly: true, providerScope: {}, writeApproved: false,
    };
    const resolved = await resolveMcpServers([{ link, connection: {
      _id: "conn", providerId: fixture.id, label: provider.displayName, authMode: "oauth",
      serverUrl: fixture.url, credentialRef: "ref", ...sealed,
    } }]);
    expect(resolved.problems).toEqual([]);
    const [runtime] = resolved.servers;
    // No vendor-enforced read-only mode: a read-only link is enforced at the tool gate.
    expect(runtime).toMatchObject({
      url: fixture.scopedUrl, readOnlyEnforced: false, annotationsTrusted: true,
      headers: { Authorization: `Bearer ${SECRET}` }, knownSecrets: [SECRET],
    });
    // Every published write stays gated even if a vendor labels it read-only.
    for (const name of provider.destructiveTools) {
      expect(requiresApproval(runtime, { name, annotations: { readOnlyHint: true } }), name).toBe(true);
    }
    expect(requiresApproval(runtime, { name: fixture.read, annotations: { readOnlyHint: true } })).toBe(false);
    expect(requiresApproval(runtime, { name: "unlisted_tool" })).toBe(true);
    const scopedProbe = await probeMcpServer({ url: runtime.url, headers: runtime.headers, trustedHosts: runtime.trustedHostnames });
    expect(scopedProbe.ok).toBe(true);
    expect(mocks.transport.mock.calls[1][0].toString()).toBe(fixture.scopedUrl);
    expect(mocks.transport.mock.calls[1][1].requestInit.headers).toEqual(runtime.headers);
    expect(JSON.stringify(scopedProbe)).not.toContain(SECRET);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["initialize", "list"] as const)("handles %s failure without leaking credentials", async (phase) => {
    failure = phase;
    mocks.createTransport = () => startServer(fixture);
    const result = await probeMcpServer({
      url: fixture.url, headers: { Authorization: `Bearer ${SECRET}` },
      trustedHosts: PROVIDERS[fixture.id].trustedHostnames,
    });
    expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an API key before probing or persisting", async () => {
    expect(PROVIDERS[fixture.id].apiKey).toBeUndefined();
    const response = await POST(new Request("http://localhost/api/integrations/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: fixture.id, apiKey: SECRET }),
    }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
