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
 *
 * ## Every side effect belongs in a step
 *
 * An Inngest function body re-executes from the top once per step. One agent turn
 * that calls one MCP tool replays the body about seven times, so anything in this
 * handler that is not inside a durable step happens about seven times.
 *
 * That was the cause of a real bug: `callMcpTool` was correctly wrapped, so the
 * remote request happened once, but the approval gate and the audit write sat in
 * the bare body. One `apply_migration` produced one Supabase request, **four**
 * approval rows and **three** audit rows — which read in the logs as a migration
 * being applied repeatedly.
 *
 * So all three now run inside steps keyed to the logical invocation
 * (`invocation.ts`), and the step ids are derived from the tool and its arguments
 * rather than from position in a sequence.
 *
 * When adding anything to this handler, put it in a step or convince yourself it
 * is idempotent and cheap. "It only runs once" is not true here.
 */

import { createTool, type Tool } from "@inngest/agent-kit";

import { callMcpTool } from "../server/mcp/call-tool";
import type { DiscoveredTool } from "../server/mcp/discover-tools";
import {
  createInvocationTracker,
  scopeRunner,
  type McpInvocation,
  type McpStepRunner,
} from "../server/mcp/invocation";
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
  /** Ties this row to one logical tool call. See `invocation.ts`. */
  invocationId: string;
  argsDigest: string;
}) => void | Promise<void>;

/**
 * Consulted before a destructive tool runs. Returning false blocks the call.
 *
 * Injected rather than implemented here so this module stays free of Convex and
 * step plumbing, and so the approval mechanism can change without touching the
 * adapter.
 *
 * `runner` is the invocation-scoped durable executor. The gate uses it so that
 * creating the approval row and waiting for an answer are durable steps rather
 * than work redone on every replay of the function body.
 *
 * `claim` exists for mutating tools. See `runMcpCall` for why.
 */
export type McpApprovalGate = (request: {
  server: ResolvedMcpServer;
  toolName: string;
  args: Record<string, unknown>;
  invocation: McpInvocation;
  runner?: McpStepRunner;
}) => Promise<{
  approved: boolean;
  reason?: string;
  approvalId?: string;
  /**
   * Atomically marks the approval as spent. Resolves false when it was already
   * spent, which means this exact invocation has already been performed.
   */
  claim?: () => Promise<boolean>;
}>;

export interface CreateMcpToolsOptions {
  servers: readonly ResolvedMcpServer[];
  /** Discovered tools per server, keyed by `projectConnectionId`. */
  toolsByConnection: Map<string, DiscoveredTool[]>;
  /** Union of secrets to strip from results. */
  knownSecrets: readonly string[];
  approvalGate?: McpApprovalGate;
  audit?: McpAuditSink;
  /**
   * Run id, for correlating log lines with the Inngest run. Only used in logs —
   * never in a step id, since it is constant for the whole run.
   */
  runId?: string;
}

/**
 * Build an `McpStepRunner` from AgentKit's step tooling.
 *
 * Returns undefined outside a workflow engine, in which case the handler runs
 * everything inline — correct, just not durable. That is the path unit tests take.
 */
function toStepRunner(step: unknown): McpStepRunner | undefined {
  const tools = step as
    | {
        run?: (id: string, fn: () => unknown) => Promise<unknown>;
        sleep?: (id: string, ms: number) => Promise<unknown>;
      }
    | undefined;

  const run = tools?.run;
  if (typeof run !== "function") return undefined;

  const sleep = tools?.sleep;

  return {
    run: (id, fn) => run.call(tools, id, fn) as Promise<never>,
    sleep: async (id, ms) => {
      if (typeof sleep === "function") {
        // Inngest treats a bare number as milliseconds.
        await sleep.call(tools, id, ms);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
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
  const {
    servers,
    toolsByConnection,
    knownSecrets,
    approvalGate,
    audit,
    runId,
  } = options;

  // Per-build, therefore per function-body execution: the counters restart on
  // every Inngest replay, which is exactly what makes the ids it hands out
  // replay-stable. See `invocation.ts`.
  const tracker = createInvocationTracker();

  const tools: Tool.Any[] = [];

  for (const server of servers) {
    const discovered = toolsByConnection.get(server.projectConnectionId) ?? [];

    for (const tool of discovered) {
      const agentTool = createTool({
        name: tool.qualifiedName,
        description: describeTool(tool, server),
        parameters: mcpInputSchemaToZod(tool.inputSchema) as never,
        handler: async (args, { step }) => {
          const callArgs = (args ?? {}) as Record<string, unknown>;
          const invocation = tracker.next(tool.qualifiedName, callArgs);
          const rootRunner = toStepRunner(step);
          const runner = rootRunner
            ? scopeRunner(rootRunner, invocation.invocationId)
            : undefined;

          /**
           * One structured line per stage of one logical call.
           *
           * `invocationId` is the join key: it appears here, on the approval row,
           * on the audit row, and in every step id for this call. Given a
           * duplicate-looking log, this is what answers "same call logged twice,
           * or two calls?" without guesswork.
           */
          const trace = (
            stage: string,
            detail: Record<string, unknown> = {},
          ) => {
            console.info(
              "[mcp]",
              JSON.stringify({
                stage,
                invocationId: invocation.invocationId,
                runId,
                provider: server.providerId,
                tool: tool.name,
                argsDigest: invocation.argsDigest,
                occurrence: invocation.occurrence,
                durable: Boolean(runner),
                ...detail,
              }),
            );
          };

          /**
           * Audit inside a step, so one real call yields one row.
           *
           * Previously this ran in the bare function body and therefore once per
           * replay — three rows for one migration, which is what made the logs
           * look like repeated execution.
           */
          const record = async (
            status: "ok" | "error" | "denied" | "blocked",
            durationMs: number,
            redactionCount = 0,
            matchedRules: string[] = [],
            errorMessage?: string,
          ) => {
            if (!audit) return;

            const write = async () => {
              await audit({
                providerId: server.providerId,
                projectConnectionId: server.projectConnectionId,
                toolName: tool.name,
                status,
                durationMs,
                redactionCount,
                matchedRules,
                errorMessage,
                invocationId: invocation.invocationId,
                argsDigest: invocation.argsDigest,
              });
              return null;
            };

            try {
              if (runner) {
                await runner.run(`audit:${status}`, write);
              } else {
                await write();
              }
              trace("audited", { status });
            } catch (error) {
              // An audit failure must not fail the tool call. Losing a log line
              // is preferable to breaking the user's request.
              console.warn("[mcp] audit sink threw", error);
            }
          };

          trace("invoked");

          // ── Approval gate ──
          //
          // The gate is handed the scoped runner so that creating the approval
          // row is a memoized step and the wait for an answer suspends durably.
          // Before, the whole gate ran in the bare function body: it created a
          // fresh pending row on every replay, and each of those rows then
          // blocked for up to fifteen minutes waiting for an answer the user had
          // already given.
          let claim: (() => Promise<boolean>) | undefined;

          if (tool.destructive && approvalGate) {
            const decision = await approvalGate({
              server,
              toolName: tool.name,
              args: callArgs,
              invocation,
              runner,
            });

            if (!decision.approved) {
              trace("denied", { approvalId: decision.approvalId });
              await record("denied", 0);
              // Returned as text, not thrown, so the model reports the refusal
              // to the user and moves on instead of retrying in a loop.
              return (
                `Not permitted: ${decision.reason ?? "the user declined this action."} ` +
                `Do not retry this tool. Explain to the user what you were trying to do ` +
                `and ask how they would like to proceed.`
              );
            }

            claim = decision.claim;
            trace("approved", { approvalId: decision.approvalId });
          }

          // A destructive tool with no gate configured is refused rather than
          // run. Failing closed matters here: the alternative is silently
          // performing an unreviewed mutation against the user's real
          // infrastructure.
          if (tool.destructive && !approvalGate) {
            trace("blocked");
            await record("blocked", 0);
            return (
              `Not permitted: "${tool.name}" modifies real data and no approval ` +
              `mechanism is available in this run. Tell the user this action needs ` +
              `to be performed manually.`
            );
          }

          const outcome = await runMcpCall({
            server,
            tool,
            args: callArgs,
            knownSecrets,
            runner,
            claim,
            trace,
          });

          if (outcome.kind === "already-applied") {
            await record("blocked", 0, 0, [], outcome.text);
            return outcome.text;
          }

          await record(
            outcome.result.ok ? "ok" : "error",
            outcome.result.durationMs,
            outcome.result.redactionCount,
            outcome.result.matchedRules,
            outcome.result.ok ? undefined : outcome.result.text.slice(0, 300),
          );

          return outcome.result.text;
        },
      });

      // AgentKit defaults every parameterised OpenAI tool to strict mode. MCP
      // schemas may legitimately omit properties from `required`, which strict
      // function calling rejects before the model can run. Keep the MCP schema's
      // optional-field semantics and let the MCP server remain authoritative.
      agentTool.strict = false;
      tools.push(agentTool);
    }
  }

  return tools;
}

type McpCallOutcome =
  | { kind: "ran"; result: Awaited<ReturnType<typeof callMcpTool>> }
  | { kind: "already-applied"; text: string };

/**
 * Perform the MCP call inside a durable step keyed to this invocation.
 *
 * ## Step id
 *
 * `mcp:<invocationId>:call`. Unique per logical invocation and stable across
 * replays, so the memoized result is returned rather than the remote call being
 * repeated. This replaces `mcp-<qualifiedName>`, which was the same id for every
 * invocation of a tool and relied on Inngest's positional auto-indexing to tell
 * repeats apart.
 *
 * ## Why mutating tools get a claim
 *
 * Step memoization removes the ordinary duplicate: a replay reads the stored
 * result instead of calling again. It cannot cover the case where the request is
 * killed *after* the remote mutation succeeded but *before* its result was
 * checkpointed. Inngest would then legitimately re-run the step, and a second
 * `apply_migration` would go out.
 *
 * For a destructive tool, `claim()` is taken as the first act inside the step. It
 * is an atomic single-use transition on the approval row, so it survives exactly
 * the failure that loses a step result. If it comes back false the mutation has
 * already been issued once, and we refuse instead of reapplying — telling the
 * model to verify rather than retry. Failing closed is the only safe direction
 * for a migration: reapplying a `create table` fails loudly, but reapplying an
 * `insert` or a destructive `alter` corrupts data silently.
 *
 * Read-only tools take no claim; repeating a read is harmless and the extra write
 * would not pay for itself.
 */
async function runMcpCall(params: {
  server: ResolvedMcpServer;
  tool: DiscoveredTool;
  args: Record<string, unknown>;
  knownSecrets: readonly string[];
  runner?: McpStepRunner;
  claim?: () => Promise<boolean>;
  trace: (stage: string, detail?: Record<string, unknown>) => void;
}): Promise<McpCallOutcome> {
  const { server, tool, args, knownSecrets, runner, claim, trace } = params;

  const alreadyApplied =
    `Not performed: "${tool.name}" on ${server.displayName} was already issued ` +
    `once for this exact request, and the previous attempt's outcome was not ` +
    `recorded. It was NOT sent again, because repeating it could duplicate a ` +
    `change to real data. Do NOT retry this tool. Check the current state of the ` +
    `database first — for example list the tables or migrations — then tell the ` +
    `user what you found.`;

  const run = async (): Promise<McpCallOutcome> => {
    if (claim) {
      const won = await claim();
      if (!won) {
        trace("claim-lost");
        return { kind: "already-applied", text: alreadyApplied };
      }
      trace("claimed");
    }

    trace("requesting");

    const result = await callMcpTool({
      server,
      toolName: tool.name,
      args,
      knownSecrets,
    });

    trace("responded", {
      ok: result.ok,
      durationMs: result.durationMs,
      redactionCount: result.redactionCount,
      truncated: result.truncated,
    });

    return { kind: "ran", result };
  };

  if (!runner) {
    // No workflow engine: correct but not durable. Unit tests and any
    // non-Inngest caller take this path.
    return run();
  }

  return runner.run("call", run);
}
