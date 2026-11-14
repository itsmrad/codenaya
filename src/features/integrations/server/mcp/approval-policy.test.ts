/**
 * Approval policy through the real MCP path: handshake, tools/list, discovery,
 * the AgentKit handler, the Convex approval gate and tools/call.
 *
 * The MCP server is a real SDK `Server` on an in-memory transport, so annotations
 * travel over the protocol exactly as a vendor would send them. Only the network
 * (transport, SSRF guard) and Convex are faked. No credentials, no vendor calls.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: (() => {
    throw new Error("transport factory not set");
  }) as () => unknown,
  resolveMcpServers: vi.fn(),
  mutation: vi.fn(),
  query: vi.fn(),
}));

// Each connection gets a fresh in-memory link to a fake server instead of HTTP.
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function () {
    return mocks.createTransport();
  }),
}));
vi.mock("../url-guard", () => ({
  assertSafeMcpUrl: async (url: string) => ({ ok: true, url: new URL(url) }),
}));
vi.mock("./resolve-servers", () => ({
  resolveMcpServers: mocks.resolveMcpServers,
  collectKnownSecrets: () => [],
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { mutation: mocks.mutation, query: mocks.query },
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpApprovalGate } from "../../adapters/agentkit";
import { buildMcpAgentTools } from "./build-agent-tools";
import { createConvexApprovalGate } from "./convex-approval";
import { requiresApproval } from "./discover-tools";
import { fingerprintTools } from "./fingerprint";
import type { ResolvedMcpServer } from "./resolve-servers";

const objectSchema = { type: "object" as const, properties: {} };

/** A server whose tool list mirrors the shapes a vendor can send. */
const TOOLS: McpTool[] = [
  // Listed as destructive, yet claims read-only: the known write list must win.
  {
    name: "stripe_api_write",
    inputSchema: objectSchema,
    annotations: { readOnlyHint: true },
  },
  // New, unlisted write tool that admits it mutates.
  {
    name: "send_money",
    inputSchema: objectSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  // Conflicting hints: destructive wins.
  {
    name: "convert_currency",
    inputSchema: objectSchema,
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
  // Unlisted and unannotated: fails closed.
  { name: "setup_recipient", inputSchema: objectSchema },
  // Verified read.
  {
    name: "list_customers",
    inputSchema: objectSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

let served: McpTool[] = TOOLS;
const called: string[] = [];

function startFakeServer() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "fake-vendor", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: served,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    called.push(request.params.name);
    return { content: [{ type: "text", text: `ran ${request.params.name}` }] };
  });
  void server.connect(serverSide);
  return clientSide;
}

function resolvedServer(
  overrides: Partial<ResolvedMcpServer> = {},
): ResolvedMcpServer {
  return {
    projectConnectionId: "pc1",
    userConnectionId: "uc1",
    providerId: "stripe",
    namespace: "stripe",
    displayName: "Stripe",
    url: "https://mcp.stripe.com/",
    headers: { Authorization: "Bearer fake" },
    trustedHostnames: ["mcp.stripe.com"],
    readOnly: false,
    writeApproved: true,
    destructiveTools: ["stripe_api_write"],
    knownSecrets: [],
    needsRefresh: false,
    ...overrides,
  };
}

async function buildTools(
  approvalGate: McpApprovalGate | undefined,
  server = resolvedServer(),
) {
  mocks.resolveMcpServers.mockResolvedValue({ servers: [server], problems: [] });
  const built = await buildMcpAgentTools({
    entries: [{ link: {}, connection: {} } as never],
    approvalGate,
  });
  const invoke = (name: string) => {
    const tool = built.tools.find((t) => t.name === `${server.namespace}__${name}`);
    if (!tool) throw new Error(`tool ${name} was not offered`);
    return tool.handler({}, {} as never) as Promise<string>;
  };
  return { built, invoke };
}

/** The real Convex gate, answering with a fixed decision. */
function convexGate(status: "approved" | "denied") {
  mocks.query.mockResolvedValue({ status, expiresAt: Infinity });
  return createConvexApprovalGate({
    internalKey: "key",
    projectId: "p1" as never,
  });
}

const approvalRows = () =>
  mocks.mutation.mock.calls.filter(
    ([ref]) => getFunctionName(ref) === "system:createMcpApproval",
  );

const GATED = ["stripe_api_write", "send_money", "convert_currency", "setup_recipient"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  served = TOOLS;
  called.length = 0;
  mocks.createTransport = startFakeServer;
  mocks.mutation.mockImplementation(async (ref) =>
    getFunctionName(ref) === "system:createMcpApproval" ? "approval_1" : true,
  );
});

describe("MCP approval policy over the protocol", () => {
  it("classifies tools from their annotations, listed writes first", async () => {
    const { built } = await buildTools(undefined);

    expect(
      Object.fromEntries(
        built.tools.map((t) => [t.name, t.description?.includes("requires approval")]),
      ),
    ).toEqual({
      stripe__convert_currency: true,
      stripe__list_customers: false,
      stripe__send_money: true,
      stripe__setup_recipient: true,
      stripe__stripe_api_write: true,
    });
  });

  it.each(GATED)("does not run %s when the user declines", async (name) => {
    const { invoke } = await buildTools(convexGate("denied"));

    expect(await invoke(name)).toMatch(/^Not permitted: .*the user declined/);
    expect(approvalRows()).toHaveLength(1);
    expect(called).toEqual([]);
  });

  it.each(GATED)("does not run %s when no approval is available", async (name) => {
    const { invoke } = await buildTools(undefined);

    expect(await invoke(name)).toMatch(/no approval mechanism is available/);
    expect(called).toEqual([]);
  });

  it("does not run a gated tool when the approval row cannot be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.mutation.mockRejectedValue(new Error("convex down"));
    const { invoke } = await buildTools(convexGate("approved"));

    expect(await invoke("setup_recipient")).toMatch(/could not be created/);
    expect(called).toEqual([]);
  });

  it("does not run a gated tool when the gate itself fails", async () => {
    const { invoke } = await buildTools(async () => {
      throw new Error("gate crashed");
    });

    await expect(invoke("send_money")).rejects.toThrow("gate crashed");
    expect(called).toEqual([]);
  });

  it("runs a gated tool once the user approves", async () => {
    const { invoke } = await buildTools(convexGate("approved"));

    expect(await invoke("setup_recipient")).toBe("ran setup_recipient");
    expect(approvalRows()).toHaveLength(1);
    expect(called).toEqual(["setup_recipient"]);
  });

  it("runs a verified read without asking", async () => {
    const { invoke } = await buildTools(convexGate("denied"));

    expect(await invoke("list_customers")).toBe("ran list_customers");
    expect(approvalRows()).toHaveLength(0);
    expect(called).toEqual(["list_customers"]);
  });

  it("gates unannotated custom-server tools but keeps their declared reads usable", async () => {
    const custom = resolvedServer({
      providerId: "custom-abc",
      namespace: "custom_abc",
      displayName: "My server",
      trustedHostnames: [],
      destructiveTools: [],
    });
    const { invoke } = await buildTools(convexGate("denied"), custom);

    expect(await invoke("setup_recipient")).toMatch(/^Not permitted/);
    expect(await invoke("list_customers")).toBe("ran list_customers");
    expect(called).toEqual(["list_customers"]);
  });

  it("lets unannotated tools read on a server-enforced read-only link, never listed ones", async () => {
    const { invoke } = await buildTools(
      convexGate("denied"),
      resolvedServer({ readOnly: true, readOnlyEnforced: true }),
    );

    expect(await invoke("setup_recipient")).toBe("ran setup_recipient");
    expect(await invoke("stripe_api_write")).toMatch(/^Not permitted/);
    expect(await invoke("send_money")).toMatch(/^Not permitted/);
    expect(called).toEqual(["setup_recipient"]);
  });

  it("withholds a tool whose read-only hint appears after approval", async () => {
    // Approved while unannotated (gated); the server now claims read-only.
    const baseline = fingerprintTools([{ name: "setup_recipient", inputSchema: objectSchema }]);
    served = [
      {
        name: "setup_recipient",
        inputSchema: objectSchema,
        annotations: { readOnlyHint: true },
      },
    ];

    const { built } = await buildTools(
      convexGate("denied"),
      resolvedServer({ toolBaseline: baseline }),
    );

    expect(built.tools).toEqual([]);
    expect(built.warnings.join("\n")).toMatch(/changed: setup_recipient/);
    expect(built.baselinesToRecord).toEqual([]);
  });
});

describe("requiresApproval", () => {
  const listed = { destructiveTools: ["write"] };

  it.each([
    ["listed, claims read-only", listed, { name: "write", annotations: { readOnlyHint: true } }, true],
    ["listed, enforced read-only link", { ...listed, readOnlyEnforced: true }, { name: "write" }, true],
    ["destructiveHint beside readOnlyHint", listed, { name: "x", annotations: { readOnlyHint: true, destructiveHint: true } }, true],
    ["destructiveHint on enforced read-only link", { ...listed, readOnlyEnforced: true }, { name: "x", annotations: { destructiveHint: true } }, true],
    ["no annotations", listed, { name: "x" }, true],
    ["empty annotations", listed, { name: "x", annotations: {} }, true],
    ["string readOnlyHint", listed, { name: "x", annotations: { readOnlyHint: "true" } }, true],
    ["readOnlyHint false", listed, { name: "x", annotations: { readOnlyHint: false } }, true],
    ["readOnlyHint true", listed, { name: "x", annotations: { readOnlyHint: true } }, false],
    ["readOnlyHint true, destructiveHint false", listed, { name: "x", annotations: { readOnlyHint: true, destructiveHint: false } }, false],
    ["unannotated on enforced read-only link", { ...listed, readOnlyEnforced: true }, { name: "x" }, false],
  ] as const)("%s → %s", (_label, server, tool, expected) => {
    expect(requiresApproval(server, tool)).toBe(expected);
  });
});
