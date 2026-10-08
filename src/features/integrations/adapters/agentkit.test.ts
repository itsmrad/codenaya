import { createAgent, openai } from "@inngest/agent-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
}));

vi.mock("../server/mcp/call-tool", () => ({
  callMcpTool: mocks.callMcpTool,
}));

import { createMcpToolsForAgentKit } from "./agentkit";

const server = {
  projectConnectionId: "project-connection-1",
  userConnectionId: "user-connection-1",
  providerId: "supabase",
  namespace: "supabase",
  displayName: "Supabase",
  url: "https://mcp.supabase.com/mcp",
  headers: { Authorization: "Bearer test-token" },
  trustedHostnames: ["mcp.supabase.com"],
  readOnly: false,
  writeApproved: true,
  destructiveTools: ["deploy_edge_function", "reset_branch"],
  knownSecrets: ["test-token"],
  needsRefresh: false,
};

const discoveredTools = [
  {
    name: "deploy_edge_function",
    qualifiedName: "supabase__deploy_edge_function",
    description: "Deploy an Edge Function.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        entrypoint_path: { type: "string" },
        import_map_path: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
            },
            required: ["name", "content"],
          },
        },
        verify_jwt: { type: "boolean" },
      },
      required: ["project_id", "name", "entrypoint_path", "files"],
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: "query_logs",
    qualifiedName: "supabase__query_logs",
    description: "Query Supabase logs.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        service: { type: "string" },
        iso_timestamp_start: { type: "string" },
        iso_timestamp_end: { type: "string" },
      },
      required: ["project_id", "service"],
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "reset_branch",
    qualifiedName: "supabase__reset_branch",
    description: "Reset a database branch.",
    inputSchema: {
      type: "object",
      properties: {
        branch_id: { type: "string" },
        migration_version: { type: "string" },
      },
      required: ["branch_id"],
      additionalProperties: false,
    },
    destructive: true,
  },
] as const;

function createSupabaseTools() {
  return createMcpToolsForAgentKit({
    servers: [server],
    toolsByConnection: new Map([
      [server.projectConnectionId, [...discoveredTools]],
    ]),
    knownSecrets: server.knownSecrets,
    approvalGate: async () => ({ approved: true }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callMcpTool.mockResolvedValue({
    text: "ok",
    ok: true,
    redactionCount: 0,
    matchedRules: [],
    truncated: false,
    durationMs: 1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP AgentKit compatibility", () => {
  it("keeps Supabase optional properties optional when invoking MCP", async () => {
    const tools = createSupabaseTools();

    const args = [
      {
        project_id: "project-ref",
        name: "hello",
        entrypoint_path: "index.ts",
        files: [{ name: "index.ts", content: "Deno.serve(() => new Response())" }],
      },
      { project_id: "project-ref", service: "edge-function" },
      { branch_id: "branch-ref" },
    ];

    for (const [index, tool] of tools.entries()) {
      expect(tool.parameters?.safeParse(args[index]).success).toBe(true);
      await tool.handler(args[index], {} as never);
    }

    expect(mocks.callMcpTool).toHaveBeenNthCalledWith(1, {
      server,
      toolName: "deploy_edge_function",
      args: args[0],
      knownSecrets: server.knownSecrets,
    });
    expect(mocks.callMcpTool).toHaveBeenNthCalledWith(2, {
      server,
      toolName: "query_logs",
      args: args[1],
      knownSecrets: server.knownSecrets,
    });
    expect(mocks.callMcpTool).toHaveBeenNthCalledWith(3, {
      server,
      toolName: "reset_branch",
      args: args[2],
      knownSecrets: server.knownSecrets,
    });
  });

  it("sends a valid complete provider request with every discovered tool", async () => {
    const tools = createSupabaseTools();
    let requestBody: Record<string, unknown> | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const requestTools = requestBody.tools as Array<{
          function: {
            name: string;
            parameters: { properties?: Record<string, unknown>; required?: string[] };
            strict: boolean;
          };
        }>;

        const invalidStrictTool = requestTools.find(({ function: tool }) => {
          if (!tool.strict) return false;
          const propertyNames = Object.keys(tool.parameters.properties ?? {});
          return propertyNames.some(
            (property) => !tool.parameters.required?.includes(property),
          );
        });

        if (invalidStrictTool) {
          return Response.json({
            error: {
              message: `Invalid schema for function '${invalidStrictTool.function.name}'`,
            },
          });
        }

        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Tools accepted." },
              finish_reason: "stop",
            },
          ],
        });
      }),
    );

    const agent = createAgent({
      name: "schema-regression",
      system: "Verify the available tools.",
      model: openai({
        model: "test-model",
        apiKey: "test-key",
        baseUrl: "https://provider.test/v1",
      }),
      tools,
    });

    await expect(agent.run("List the tools.")).resolves.toBeDefined();

    const requestTools = requestBody?.tools as Array<{
      function: {
        name: string;
        parameters: { required?: string[] };
        strict: boolean;
      };
    }>;
    expect(requestTools.map(({ function: tool }) => tool.name)).toEqual(
      discoveredTools.map((tool) => tool.qualifiedName),
    );
    expect(requestTools.every(({ function: tool }) => tool.strict === false)).toBe(
      true,
    );
    expect(requestTools[0].function.parameters.required).not.toContain(
      "import_map_path",
    );
    expect(requestTools[1].function.parameters.required).not.toEqual(
      expect.arrayContaining(["iso_timestamp_start", "iso_timestamp_end"]),
    );
    expect(requestTools[2].function.parameters.required).not.toContain(
      "migration_version",
    );
  });
});
