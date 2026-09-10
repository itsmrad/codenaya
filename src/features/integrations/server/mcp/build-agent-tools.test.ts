import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveMcpServers: vi.fn(),
  collectKnownSecrets: vi.fn(),
  discoverTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

vi.mock("./resolve-servers", () => ({
  resolveMcpServers: mocks.resolveMcpServers,
  collectKnownSecrets: mocks.collectKnownSecrets,
}));

vi.mock("./discover-tools", () => ({
  discoverTools: mocks.discoverTools,
}));

vi.mock("./call-tool", () => ({
  callMcpTool: mocks.callMcpTool,
}));

import {
  buildIntegrationsPromptSection,
  buildMcpAgentTools,
} from "./build-agent-tools";

const supabaseServer = {
  projectConnectionId: "project-connection-1",
  userConnectionId: "user-connection-1",
  providerId: "supabase",
  namespace: "supabase",
  displayName: "Supabase",
  url: "https://mcp.supabase.com/mcp?read_only=true",
  headers: { Authorization: "Bearer oauth-access-token" },
  trustedHostnames: ["mcp.supabase.com"],
  readOnly: true,
  writeApproved: false,
  destructiveTools: [],
  knownSecrets: ["oauth-access-token"],
  needsRefresh: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveMcpServers.mockResolvedValue({
    servers: [supabaseServer],
    problems: [],
  });
  mocks.collectKnownSecrets.mockReturnValue(["oauth-access-token"]);
  mocks.discoverTools.mockResolvedValue({
    ok: true,
    tools: [
      {
        name: "list_tables",
        qualifiedName: "supabase__list_tables",
        description: "List tables in a Supabase project",
        inputSchema: {
          type: "object",
          properties: { project_id: { type: "string" } },
          required: ["project_id"],
        },
        destructive: false,
      },
    ],
    fingerprints: [{ name: "list_tables", digest: "digest-1" }],
    drift: { changed: [], added: ["list_tables"], removed: [] },
    driftDetected: false,
    capped: false,
    offeredCount: 1,
  });
  mocks.callMcpTool.mockResolvedValue({
    text: '[{"name":"users"}]',
    ok: true,
    redactionCount: 0,
    matchedRules: [],
    truncated: false,
    durationMs: 12,
  });
});

describe("project-scoped MCP tool loading", () => {
  it("turns an attached Supabase connection into an invokable agent tool", async () => {
    const built = await buildMcpAgentTools({
      entries: [{} as never],
    });

    expect(built.connectedSummaries).toEqual([
      "Supabase (read-only): supabase__list_tables",
    ]);
    expect(built.tools.map((tool) => tool.name)).toEqual([
      "supabase__list_tables",
    ]);

    const result = await built.tools[0].handler(
      { project_id: "supabase-project-ref" },
      {} as never,
    );

    expect(result).toBe('[{"name":"users"}]');
    expect(mocks.callMcpTool).toHaveBeenCalledWith({
      server: supabaseServer,
      toolName: "list_tables",
      args: { project_id: "supabase-project-ref" },
      knownSecrets: ["oauth-access-token"],
    });
  });

  it("loads no external tools when the project has no attached connection", async () => {
    const built = await buildMcpAgentTools({ entries: [] });

    expect(built.tools).toEqual([]);
    expect(mocks.resolveMcpServers).not.toHaveBeenCalled();
  });
});

describe("buildIntegrationsPromptSection", () => {
  it("treats discovered MCP access as authoritative over workspace files", () => {
    const section = buildIntegrationsPromptSection(
      ["Supabase (read-only): supabase__list_projects"],
      [],
    );

    expect(section).toContain("Supabase (read-only)");
    expect(section).toContain("authenticated");
    expect(section).toContain("independent of the project's npm dependencies");
    expect(section).toContain("use its tools before answering");
    expect(section).toContain("Never claim that access is unverified");
  });
});

describe("no project-scoped integrations", () => {
  it("does not use workspace dependencies or env vars as connection evidence", () => {
    const section = buildIntegrationsPromptSection([], []);

    expect(section).toContain("No usable project-scoped integrations");
    expect(section).toContain("authoritative integration state");
    expect(section).toContain("Do not infer integration access");
    expect(section).toContain("do not claim that an SDK or env var is required");
  });

  it("keeps the authoritative unavailable state when discovery reports an issue", () => {
    const section = buildIntegrationsPromptSection([], [
      "Supabase: could not list tools (Unauthorized)",
    ]);

    expect(section).toContain("No usable project-scoped integrations");
    expect(section).toContain("Supabase: could not list tools (Unauthorized)");
  });
});
