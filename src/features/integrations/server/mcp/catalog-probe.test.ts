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
  id: "posthog" | "resend" | "upstash" | "sanity" | "planetscale";
  url: string;
  scope: ProjectLinkRecord["providerScope"];
  scopedUrl: string;
  scopeHeaders: Record<string, string>;
  enforced: boolean;
  read: string;
  write: string;
}

const CASES: Fixture[] = [
  {
    id: "posthog", url: "https://mcp.posthog.com/mcp",
    scope: { features: ["insights", "flags"], projectRef: "123" },
    scopedUrl: "https://mcp.posthog.com/mcp?features=flags%2Cinsights&project_id=123",
    scopeHeaders: { "x-posthog-read-only": "true" }, enforced: true,
    read: "dashboard-get", write: "dashboard-create",
  },
  {
    id: "resend", url: "https://mcp.resend.com/mcp", scope: {},
    scopedUrl: "https://mcp.resend.com/mcp", scopeHeaders: {}, enforced: false,
    read: "list-emails", write: "send-email",
  },
  {
    id: "upstash", url: "https://mcp.upstash.com/mcp",
    scope: { features: ["vector_search", "redis", "qstash_workflow"] },
    scopedUrl: "https://mcp.upstash.com/mcp?features=qstash_workflow%2Credis%2Cvector_search",
    scopeHeaders: {}, enforced: false,
    read: "redis_list_databases", write: "redis_run_command",
  },
  {
    id: "sanity", url: "https://mcp.sanity.io", scope: {},
    scopedUrl: "https://mcp.sanity.io/", scopeHeaders: {}, enforced: false,
    read: "query_documents", write: "publish_documents",
  },
  {
    id: "planetscale", url: "https://mcp.pscale.dev/mcp/planetscale", scope: {},
    scopedUrl: "https://mcp.pscale.dev/mcp/planetscale-insights-only",
    scopeHeaders: {}, enforced: true,
    read: "planetscale_get_insights", write: "planetscale_execute_write_query",
  },
];

const SECRET = "account@example.test:b2-test-credential-never-return";
const servers: Server[] = [];
let failure: "initialize" | "list" | undefined;

function startServer(fixture: Fixture) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: fixture.id, version: "1.0.0" }, { capabilities: { tools: {} } },
  );
  const reject = () => { throw new McpError(ErrorCode.InternalError, `HTTP 401 ${SECRET}`); };
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
  it("probes an OAuth credential and composes the runtime scope without leaking the token", async () => {
    const provider = PROVIDERS[fixture.id];
    mocks.createTransport = () => startServer(fixture);
    expect(provider.authModes).toContain("oauth");
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
      _id: "link", readOnly: true, providerScope: fixture.scope, writeApproved: false,
    };
    const resolved = await resolveMcpServers([{ link, connection: {
      _id: "conn", providerId: fixture.id, label: provider.displayName, authMode: "oauth",
      serverUrl: fixture.url, credentialRef: "ref", ...sealed,
    } }]);
    expect(resolved.problems).toEqual([]);
    const [runtime] = resolved.servers;
    expect(runtime).toMatchObject({
      url: fixture.scopedUrl, readOnlyEnforced: fixture.enforced, annotationsTrusted: true,
      headers: { ...fixture.scopeHeaders, Authorization: `Bearer ${SECRET}` }, knownSecrets: [SECRET],
    });
    // The explicit write list wins even if the provider claims a write is a read.
    expect(requiresApproval(runtime, { name: fixture.write, annotations: { readOnlyHint: true } })).toBe(true);
    expect(requiresApproval({ ...runtime, readOnlyEnforced: false }, { name: "unlisted_tool" })).toBe(true);
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
});

describe.each(CASES.filter(({ id }) => id !== "planetscale"))("$id API-key connect probe", (fixture) => {
  it("uses the registry header and prefix in both the connect probe and runtime", async () => {
    mocks.createTransport = () => startServer(fixture);
    const response = await POST(new Request("http://localhost/api/integrations/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: fixture.id, apiKey: ` ${SECRET} ` }),
    }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    const stored = mocks.mutation.mock.calls[0][1];
    const resolved = await resolveMcpServers([{
      connection: { ...stored, _id: "conn" },
      link: { _id: "link", readOnly: true, writeApproved: false, providerScope: fixture.scope },
    }]);
    expect(resolved.problems).toEqual([]);
    const placement = PROVIDERS[fixture.id].apiKey;
    if (!placement) throw new Error(`Missing API key placement for ${fixture.id}`);
    expect(placement).toMatchObject({ header: "Authorization", valuePrefix: "Bearer " });
    const auth = { [placement.header]: `${placement.valuePrefix}${SECRET}` };
    expect(mocks.transport.mock.calls[0][0].toString()).toBe(new URL(fixture.url).toString());
    expect(mocks.transport.mock.calls[0][1].requestInit.headers).toEqual(auth);
    expect(resolved.servers[0].headers).toEqual({ ...fixture.scopeHeaders, ...auth });
    expect(resolved.servers[0].url).toBe(fixture.scopedUrl);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not persist a key when the real probe fails", async () => {
    failure = "list";
    mocks.createTransport = () => startServer(fixture);
    const response = await POST(new Request("http://localhost/api/integrations/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: fixture.id, apiKey: SECRET }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("keeps PlanetScale OAuth-only until service-token placement is verified", async () => {
  expect(PROVIDERS.planetscale.authModes).toEqual(["oauth"]);
  expect(PROVIDERS.planetscale.apiKey).toBeUndefined();
  const response = await POST(new Request("http://localhost/api/integrations/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "planetscale", apiKey: SECRET }),
  }));
  expect(response.status).toBe(400);
  expect(mocks.transport).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
