/**
 * Adapter turning discovered MCP tools into AgentKit tools.
 *
 * ## Why not AgentKit's built-in `mcpServers`
 *
 * AgentKit accepts `mcpServers` on `createAgent` and will fetch and namespace
 * tools for us. We deliberately do not use it, because it leaves no seam for the
 * four things this feature exists to guarantee:
 *
 * 1. **Redaction** of results before they enter the conversation.
 * 2. **Approval gates** on destructive tools.
 * 3. **Audit logging** of every call.
 * 4. **Drift detection** against the approved baseline.
 *
 * Going through our own core also means the behaviour is identical regardless of
 * which agent backend consumes it, so adding the Vercel Workflow adapter later is
 * a thin translation rather than a re-implementation of the security properties.
 *
 * ## Schema conversion
 *
 * MCP publishes JSON Schema; AgentKit's `createTool` expects a Zod schema.
 * `mcpInputSchemaToZod` handles that — see its header for why AgentKit's own
 * `@dmitryrechkin/json-schema-to-zod` could not be reused (it resolves a nested
 * Zod 3 while AgentKit validates with the project's Zod 4).
 */

import { createTool, type Tool } from "@inngest/agent-kit";

import { callMcpTool } from "../server/mcp/call-tool";
import type { DiscoveredTool } from "../server/mcp/discover-tools";
import { mcpInputSchemaToZod } from "../server/mcp/json-schema";
import type { ResolvedMcpServer } from "../server/mcp/resolve-servers";

/** Called after each invocation so the caller can persist an audit row. */
export type McpAuditSink = (entry: {
  providerId: string;
  projectConnectionId: string;
  toolName: string;
  status: "ok" | "error" | "denied" | "blocked";
  durationMs: number;
  redactionCount: number;
  matchedRules: string[];
  errorMessage?: string;
}) => void | Promise<void>;

/**
 * Consulted before a destructive tool runs. Returning false blocks the call.
 *
 * Injected rather than implemented here so this module stays free of Convex and
 * step plumbing, and so the approval mechanism can change without touching the
 * adapter.
 */
export type McpApprovalGate = (request: {
  server: ResolvedMcpServer;
  toolName: string;
  args: Record<string, unknown>;
}) => Promise<{ approved: boolean; reason?: string }>;

export interface CreateMcpToolsOptions {
  servers: readonly ResolvedMcpServer[];
  /** Discovered tools per server, keyed by `projectConnectionId`. */
  toolsByConnection: Map<string, DiscoveredTool[]>;
  /** Union of secrets to strip from results. */
  knownSecrets: readonly string[];
  approvalGate?: McpApprovalGate;
  audit?: McpAuditSink;
}

/**
 * Prefix added to every MCP tool description.
 *
 * The model needs to know which external service a tool reaches, because the
 * consequences differ from the local file tools it is used to. Naming the provider
 * and the read-only posture in the description is what makes it treat a write as
 * significant.
 */
function describeTool(
  tool: DiscoveredTool,
  server: ResolvedMcpServer,
): string {
  const parts = [`[${server.displayName}]`];

  if (tool.destructive) {
    parts.push("(modifies real data — requires approval)");
  } else if (server.readOnly) {
    parts.push("(read-only)");
  }

  parts.push(tool.description ?? `Call the ${tool.name} tool.`);
  return parts.join(" ");
}

/**
 * Build the AgentKit tool array for a project's connected MCP servers.
 *
 * Returns a flat list because AgentKit takes one `tools` array; namespacing keeps
 * names unique across providers.
 */
export function createMcpToolsForAgentKit(
  options: CreateMcpToolsOptions,
): Tool.Any[] {
  const { servers, toolsByConnection, knownSecrets, approvalGate, audit } =
    options;

  const tools: Tool.Any[] = [];

  for (const server of servers) {
    const discovered = toolsByConnection.get(server.projectConnectionId) ?? [];

    for (const tool of discovered) {
      tools.push(
        createTool({
          name: tool.qualifiedName,
          description: describeTool(tool, server),
          parameters: mcpInputSchemaToZod(tool.inputSchema) as never,
          handler: async (args, { step }) => {
            const callArgs = (args ?? {}) as Record<string, unknown>;

            const record = async (
              status: "ok" | "error" | "denied" | "blocked",
              durationMs: number,
              redactionCount = 0,
              matchedRules: string[] = [],
              errorMessage?: string,
            ) => {
              if (!audit) return;
              try {
                await audit({
                  providerId: server.providerId,
                  projectConnectionId: server.projectConnectionId,
                  toolName: tool.name,
                  status,
                  durationMs,
                  redactionCount,
                  matchedRules,
                  errorMessage,
                });
              } catch (error) {
                // An audit failure must not fail the tool call. Losing a log line
                // is preferable to breaking the user's request.
                console.warn("[mcp] audit sink threw", error);
              }
            };

            // ── Approval gate ──
            if (tool.destructive && approvalGate) {
              const decision = await approvalGate({
                server,
                toolName: tool.name,
                args: callArgs,
              });

              if (!decision.approved) {
                await record("denied", 0);
                // Returned as text, not thrown, so the model reports the refusal
                // to the user and moves on instead of retrying in a loop.
                return (
                  `Not permitted: ${decision.reason ?? "the user declined this action."} ` +
                  `Do not retry this tool. Explain to the user what you were trying to do ` +
                  `and ask how they would like to proceed.`
                );
              }
            }

            // A destructive tool with no gate configured is refused rather than
            // run. Failing closed matters here: the alternative is silently
            // performing an unreviewed mutation against the user's real
            // infrastructure.
            if (tool.destructive && !approvalGate) {
              await record("blocked", 0);
              return (
                `Not permitted: "${tool.name}" modifies real data and no approval ` +
                `mechanism is available in this run. Tell the user this action needs ` +
                `to be performed manually.`
              );
            }

            // Wrapped in a durable step so a retried agent turn does not re-issue
            // the network call, matching how the existing file tools behave.
            const run = async () =>
              callMcpTool({
                server,
                toolName: tool.name,
                args: callArgs,
                knownSecrets,
              });

            const outcome = step
              ? await step.run(`mcp-${tool.qualifiedName}`, run)
              : await run();

            await record(
              outcome.ok ? "ok" : "error",
              outcome.durationMs,
              outcome.redactionCount,
              outcome.matchedRules,
              outcome.ok ? undefined : outcome.text.slice(0, 300),
            );

            return outcome.text;
          },
        }),
      );
    }
  }

  return tools;
}
