/**
 * End-to-end step-isolation tests for the MCP tool path.
 *
 * ## What these prove
 *
 * That **one** model tool call for a mutating MCP tool produces **exactly one** of
 * each real side effect — one remote request, one approval prompt, one audit row —
 * across the whole stack:
 *
 *     model tool call → AgentKit network → adapter handler → callMcpTool
 *
 * and that this holds under Inngest's real replay semantics, where the function
 * body is re-executed from the top once per step and only completed steps are
 * memoized.
 *
 * ## Why the real execution engine
 *
 * A hand-rolled fake `step.run` would prove nothing: the whole question is whether
 * Inngest's *actual* memoization lines up with what the adapter does. So these
 * tests drive `fn.createExecution(...)` — the same entry point
 * `InngestCommHandler.runStep` uses — and replay it in a loop the way the Inngest
 * platform does, feeding completed step results back in as `stepState` /
 * `stepCompletionOrder`.
 *
 * The approval gate is the real `requestApproval` over a fake transport, rather
 * than a stub returning `{ approved: true }`. The bug being guarded against was
 * *in* that wiring, so stubbing it would test nothing.
 *
 * The only mocked boundaries are the model's HTTP endpoint (which Inngest's AI
 * gateway owns in production) and `callMcpTool`. Everything between is production
 * code.
 *
 * ## Regression being guarded
 *
 * Before the fix, one `apply_migration` produced 1 remote request but **4**
 * approval rows and **3** audit rows, because the gate and the audit write sat in
 * the bare function body and so re-ran on all 7 replays.
 */

import { createAgent, createNetwork, openai, type Tool } from "@inngest/agent-kit";
import { Inngest } from "inngest";
import { StepMode } from "inngest/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
}));

vi.mock("./call-tool", () => ({
  callMcpTool: mocks.callMcpTool,
}));

import { createMcpToolsForAgentKit } from "../../adapters/agentkit";
import type { McpApprovalGate } from "../../adapters/agentkit";
import { requestApproval, type ApprovalRow } from "./approval";
import type { DiscoveredTool } from "./discover-tools";
import { digestToolArgs } from "./invocation";
import type { ResolvedMcpServer } from "./resolve-servers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
  destructiveTools: ["apply_migration"],
  knownSecrets: ["test-token"],
  needsRefresh: false,
} as unknown as ResolvedMcpServer;

const applyMigration: DiscoveredTool = {
  name: "apply_migration",
  qualifiedName: "supabase__apply_migration",
  description: "Apply a migration to the database.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      name: { type: "string" },
      query: { type: "string" },
    },
    required: ["project_id", "name", "query"],
    additionalProperties: false,
  },
  destructive: true,
};

const listTables: DiscoveredTool = {
  name: "list_tables",
  qualifiedName: "supabase__list_tables",
  description: "List tables.",
  inputSchema: {
    type: "object",
    properties: { project_id: { type: "string" } },
    required: ["project_id"],
    additionalProperties: false,
  },
  destructive: false,
};

const MIGRATION_ARGS = {
  project_id: "abcdefghijklmnopqrst",
  name: "create_router_models",
  query:
    "create table router_models (id uuid primary key default gen_random_uuid(), name text not null);",
};

// ── A stand-in for the Convex approval store ──────────────────────────────────

/**
 * Records every write the gate performs, so the tests can count real side effects
 * rather than function entries. The gate is *entered* once per replay by design —
 * what must not repeat is the row it creates.
 *
 * Mirrors the production Convex behaviour that matters here: creation is
 * idempotent on `invocationId`, and `claim` is single-use.
 */
function createApprovalStore(
  options: {
    statusAfterReads?: number;
    startPending?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const { statusAfterReads = 0, startPending = false, timeoutMs } = options;

  const rows = new Map<
    string,
    { id: string; status: ApprovalRow["status"]; expiresAt: number; consumedAt?: number }
  >();
  const byInvocation = new Map<string, string>();

  const inserts: string[] = [];
  const claims: Array<{ approvalId: string; won: boolean }> = [];
  let reads = 0;
  let nextId = 1;

  const gate: McpApprovalGate = async ({
    server: srv,
    toolName,
    args,
    invocation,
    runner,
  }) => {
    const decision = await requestApproval({
      transport: {
        async create(request) {
          // Idempotent on the invocation id, exactly as `createMcpApproval` is.
          const existing = byInvocation.get(request.invocationId);
          if (existing) return existing;

          const id = `approval_${nextId++}`;
          rows.set(id, {
            id,
            status: startPending ? "pending" : "approved",
            expiresAt: request.expiresAt,
          });
          byInvocation.set(request.invocationId, id);
          inserts.push(request.invocationId);
          return id;
        },
        async read(approvalId) {
          reads += 1;
          const row = rows.get(approvalId);
          if (!row) return null;
          if (startPending && reads > statusAfterReads) {
            row.status = "approved";
          }
          return { status: row.status, expiresAt: row.expiresAt };
        },
        async expire(approvalId) {
          const row = rows.get(approvalId);
          if (row && row.status === "pending") row.status = "expired";
        },
        async sleep() {
          /* durable sleeps go through the runner instead */
        },
      },
      providerId: srv.providerId,
      projectConnectionId: srv.projectConnectionId,
      displayName: srv.displayName,
      toolName,
      args,
      invocationId: invocation.invocationId,
      runner,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    if (!decision.approved) {
      return { approved: false, approvalId: decision.approvalId, reason: decision.reason };
    }

    const approvalId = decision.approvalId!;

    return {
      approved: true,
      approvalId,
      claim: async () => {
        const row = rows.get(approvalId);
        const won = Boolean(row && row.status === "approved" && !row.consumedAt);
        if (won) row!.consumedAt = Date.now();
        claims.push({ approvalId, won });
        return won;
      },
    };
  };

  return {
    gate,
    /** One entry per approval row actually inserted. */
    inserts,
    claims,
    readCount: () => reads,
  };
}

// ── A scripted model ──────────────────────────────────────────────────────────

/**
 * `step.ai.infer` is reported to Inngest as an `AIGateway` op: the *platform*
 * performs the HTTP request and memoizes the raw response. So the driver, not a
 * `fetch` stub, supplies each inference result — which mirrors production and
 * means inference is memoized and never repeated on replay.
 *
 * Each entry is one inference response, consumed in order. This is what makes "the
 * model asked for the migration once" a controlled fact: if the tool runs more
 * than once, it cannot be because the model asked twice.
 */
function scriptModel(script: ReadonlyArray<unknown>) {
  let index = 0;

  // A direct call to the *model* endpoint would mean an inference escaped
  // memoization, so that fails loudly. Inngest's own API calls (checkpoint
  // streaming) are allowed through as no-ops; they are not under test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("openrouter.test")) {
        throw new Error(
          "Unexpected direct fetch: an inference bypassed step.ai.infer memoization",
        );
      }

      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  return {
    next() {
      const response = script[Math.min(index, script.length - 1)];
      index += 1;
      return response;
    },
  };
}

function toolCallResponse(id: string, name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function textResponse(content: string) {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

// ── Inngest driver ────────────────────────────────────────────────────────────

const inngest = new Inngest({ id: "step-isolation-test" });

interface DriveOutcome {
  /** Userland ids of steps that completed, in order. */
  stepIds: string[];
  /** How many times the function body was executed from the top. */
  bodyExecutions: number;
  /** How many durable sleeps the run performed. */
  sleeps: number;
  /** Final attempt number reached, so a simulated retry can be asserted. */
  attempts: number;
  finalType: string;
  error?: unknown;
}

/**
 * Replay an Inngest function the way the platform does.
 *
 * One `createExecution().start()` per request. Three things can come back:
 *
 * - `step-ran` — the SDK executed a newly-discovered `step.run` in-band.
 * - `steps-found` with an `AIGateway` op — Inngest itself performs the inference,
 *   so the driver supplies the scripted response as that step's memoized data.
 * - `steps-found` with a `Sleep` op — Inngest schedules a durable sleep and the
 *   run resumes later; the driver completes it immediately.
 *
 * Either way the result is written into `stepState` and the function body is
 * re-executed **from the top**. That re-execution is the behaviour that punishes
 * any side effect performed outside a step.
 */
async function drive(
  buildFn: () => ReturnType<typeof inngest.createFunction>,
  model: { next: () => unknown },
  {
    maxRequests = 400,
    /**
     * Simulate an Inngest function-level retry once the named step has completed.
     *
     * A retry replays the body from the top with the accumulated step state and an
     * incremented attempt, which is what the loop below already does — so the only
     * thing to model is the attempt number.
     */
    retryAfterStep,
  }: { maxRequests?: number; retryAfterStep?: string } = {},
): Promise<DriveOutcome> {
  const event = { name: "message/sent", data: { message: "Create a table." } };

  const stepState: Record<string, unknown> = {};
  const order: string[] = [];
  const stepIds: string[] = [];
  let bodyExecutions = 0;
  let sleeps = 0;
  let attempt = 0;

  for (let request = 0; request < maxRequests; request += 1) {
    bodyExecutions += 1;

    const execution = (
      buildFn() as unknown as {
        createExecution: (o: { partialOptions: Record<string, unknown> }) => {
          start: () => Promise<Record<string, unknown>>;
        };
      }
    ).createExecution({
      partialOptions: {
        client: inngest,
        runId: "run-under-test",
        stepMode: StepMode.Async,
        data: {
          event,
          events: [event],
          runId: "run-under-test",
          attempt,
        },
        stepState: { ...stepState },
        stepCompletionOrder: [...order],
        reqArgs: [],
        headers: {},
      },
    });

    const result = (await execution.start()) as {
      type: string;
      step?: { id: string; data?: unknown; error?: unknown; userland?: { id: string } };
      steps?: Array<{ id: string; op?: string; userland?: { id: string } }>;
      error?: unknown;
    };

    if (result.type === "step-ran" && result.step) {
      const { id, data, error, userland } = result.step;
      stepState[id] = { id, ...(error ? { error } : { data }) };
      order.push(id);
      const userlandId = userland?.id ?? id;
      stepIds.push(userlandId);
      if (retryAfterStep && userlandId === retryAfterStep) attempt += 1;
      continue;
    }

    if (result.type === "steps-found" && result.steps) {
      for (const found of result.steps) {
        if (found.op === "AIGateway") {
          stepState[found.id] = { id: found.id, data: model.next() };
        } else if (found.op === "Sleep") {
          sleeps += 1;
          stepState[found.id] = { id: found.id, data: null };
        } else {
          throw new Error(
            `Unexpected platform-executed op "${found.op}" for ` +
              `"${found.userland?.id ?? found.id}"`,
          );
        }
        order.push(found.id);
        stepIds.push(found.userland?.id ?? found.id);
      }
      continue;
    }

    return {
      stepIds,
      bodyExecutions,
      sleeps,
      attempts: attempt,
      finalType: result.type,
      error: result.error,
    };
  }

  throw new Error(`Function did not settle within ${maxRequests} requests`);
}

// ── Function under test ───────────────────────────────────────────────────────

/**
 * Mirror of the production wiring in `process-message.ts`: a single-agent network
 * whose router keeps going while the last result contained tool calls.
 */
function buildProcessMessageLike(options: {
  tools?: DiscoveredTool[];
  approvalGate?: McpApprovalGate;
  audit?: Parameters<typeof createMcpToolsForAgentKit>[0]["audit"];
}) {
  const { tools = [applyMigration], approvalGate, audit } = options;

  return () =>
    inngest.createFunction(
      {
        id: "process-message-like",
        retries: 0,
        triggers: [{ event: "message/sent" }],
      },
      async () => {
        const mcpTools: Tool.Any[] = createMcpToolsForAgentKit({
          servers: [server],
          toolsByConnection: new Map([[server.projectConnectionId, tools]]),
          knownSecrets: server.knownSecrets,
          approvalGate,
          audit,
          runId: "run-under-test",
        });

        const codingAgent = createAgent({
          name: "codenaya",
          description: "An expert AI coding assistant",
          system: "You are a coding agent.",
          model: openai({
            model: "test-model",
            apiKey: "test-key",
            baseUrl: "https://openrouter.test/v1",
          }),
          tools: mcpTools,
        });

        const network = createNetwork({
          name: "codenaya-network",
          agents: [codingAgent],
          maxIter: 20,
          router: ({ network: net }) => {
            const lastResult = net.state.results.at(-1);
            const hasTextResponse = lastResult?.output.some(
              (m) => m.type === "text" && m.role === "assistant",
            );
            const hasToolCalls = lastResult?.output.some(
              (m) => m.type === "tool_call",
            );
            if (hasTextResponse && !hasToolCalls) return undefined;
            return codingAgent;
          },
        });

        await network.run("Create a router_models table.");
        return { done: true };
      },
    );
}

/** Collects audit rows the way Convex would, keyed for duplicate detection. */
function createAuditCollector() {
  const rows: Array<{ invocationId: string; status: string; argsDigest: string }> = [];
  return {
    rows,
    sink: ((entry) => {
      rows.push({
        invocationId: entry.invocationId,
        status: entry.status,
        argsDigest: entry.argsDigest,
      });
    }) as Parameters<typeof createMcpToolsForAgentKit>[0]["audit"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.callMcpTool.mockImplementation(async () => ({
    text: "Migration applied.",
    ok: true,
    redactionCount: 0,
    matchedRules: [],
    truncated: false,
    durationMs: 3,
  }));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("one intended migration → one of each real side effect", () => {
  it("issues one Supabase request, one approval row and one audit row", async () => {
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("Created the router_models table."),
    ]);
    const store = createApprovalStore();
    const audit = createAuditCollector();

    const outcome = await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
    );

    expect(outcome.finalType).toBe("function-resolved");

    // Sanity: the body really was replayed, so the counts below are evidence of
    // memoization rather than of a run that only executed once.
    expect(outcome.bodyExecutions).toBeGreaterThan(1);

    const migrationRequests = mcpToolCalls();
    expect(migrationRequests).toHaveLength(1);
    expect(migrationRequests[0]).toMatchObject({
      toolName: "apply_migration",
      args: MIGRATION_ARGS,
    });

    // The regression: these were 4 and 3.
    expect(store.inserts).toHaveLength(1);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].status).toBe("ok");

    // The mutation was claimed exactly once, and won.
    expect(store.claims).toEqual([
      { approvalId: "approval_1", won: true },
    ]);
  });

  it("ties the audit row to the approval and the step id", async () => {
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("Done."),
    ]);
    const store = createApprovalStore();
    const audit = createAuditCollector();

    const outcome = await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
    );

    const invocationId = audit.rows[0].invocationId;

    // Same key on the approval row, the audit row and every step for this call.
    expect(store.inserts).toEqual([invocationId]);
    expect(outcome.stepIds).toContain(`mcp:${invocationId}:call`);
    expect(outcome.stepIds).toContain(`mcp:${invocationId}:audit:ok`);

    // The key names the tool and digests the arguments, so it is meaningful on
    // its own in a log line.
    expect(invocationId).toMatch(/^supabase__apply_migration#[0-9a-f]{16}#0$/);
  });

  it("waits durably for a pending approval without re-prompting", async () => {
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("Done."),
    ]);
    // Stays pending for the first two reads, then the user approves.
    const store = createApprovalStore({ startPending: true, statusAfterReads: 2 });
    const audit = createAuditCollector();

    const outcome = await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
    );

    expect(outcome.finalType).toBe("function-resolved");
    // The wait suspended durably rather than blocking the request.
    expect(outcome.sleeps).toBeGreaterThan(0);
    // One prompt, despite the wait spanning several replays.
    expect(store.inserts).toHaveLength(1);
    expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
    expect(audit.rows).toHaveLength(1);
  });
});

describe("legitimate separate calls still work", () => {
  it("performs two different migrations", async () => {
    const second = { ...MIGRATION_ARGS, name: "create_router_costs" };

    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      toolCallResponse("call_2", "supabase__apply_migration", second),
      textResponse("Both migrations applied."),
    ]);
    const store = createApprovalStore();
    const audit = createAuditCollector();

    const outcome = await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
    );

    expect(outcome.finalType).toBe("function-resolved");
    expect(
      mocks.callMcpTool.mock.calls.map(
        ([arg]) => (arg as { args: { name: string } }).args.name,
      ),
    ).toEqual(["create_router_models", "create_router_costs"]);

    // Two distinct invocations, so two prompts and two audit rows.
    expect(store.inserts).toHaveLength(2);
    expect(new Set(store.inserts).size).toBe(2);
    expect(audit.rows).toHaveLength(2);
  });

  it("performs the same migration twice when the agent asks twice", async () => {
    // Identical arguments. Told apart by occurrence, not by content, so a
    // deliberate repeat is not mistaken for a replay.
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      toolCallResponse("call_2", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("Applied twice."),
    ]);
    const store = createApprovalStore();
    const audit = createAuditCollector();

    await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
    );

    expect(mocks.callMcpTool).toHaveBeenCalledTimes(2);
    expect(store.inserts).toHaveLength(2);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0].invocationId).toMatch(/#0$/);
    expect(audit.rows[1].invocationId).toMatch(/#1$/);
    // Same arguments, so the same digest — the occurrence is what separates them.
    expect(audit.rows[0].argsDigest).toBe(audit.rows[1].argsDigest);
  });

  it("calls a read-only tool once and takes no claim", async () => {
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__list_tables", {
        project_id: MIGRATION_ARGS.project_id,
      }),
      textResponse("Here are the tables."),
    ]);
    const store = createApprovalStore();
    const audit = createAuditCollector();

    await drive(
      buildProcessMessageLike({
        tools: [listTables],
        approvalGate: store.gate,
        audit: audit.sink,
      }),
      model,
    );

    expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
    // Not destructive: no prompt, no claim.
    expect(store.inserts).toHaveLength(0);
    expect(store.claims).toHaveLength(0);
    expect(audit.rows).toHaveLength(1);
  });
});

describe("mutating tools fail closed", () => {
  it("does not run a denied migration", async () => {
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("I could not apply it."),
    ]);
    const audit = createAuditCollector();

    // Never approved. A short deadline so the durable wait lapses quickly; the
    // production timeout is fifteen minutes.
    const store = createApprovalStore({
      startPending: true,
      statusAfterReads: 1e9,
      timeoutMs: 50,
    });

    await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
    );

    expect(mocks.callMcpTool).not.toHaveBeenCalled();
    expect(store.claims).toHaveLength(0);
    // Refused, and recorded as such — exactly one row, not one per replay.
    expect(audit.rows.map((r) => r.status)).toEqual(["denied"]);
  });

  it("refuses to reissue a migration whose claim was already taken", async () => {
    // Simulates the one case memoization cannot cover: the remote mutation
    // succeeded but its step result was lost, so the step runs again.
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("Checked the database."),
    ]);
    const audit = createAuditCollector();
    const store = createApprovalStore();

    // Take the claim out from under the run before it starts.
    let stolen = false;
    const gate: McpApprovalGate = async (request) => {
      const decision = await store.gate(request);
      if (!decision.approved || !decision.claim) return decision;
      if (!stolen) {
        stolen = true;
        await decision.claim();
      }
      return decision;
    };

    await drive(
      buildProcessMessageLike({ approvalGate: gate, audit: audit.sink }),
      model,
    );

    // The migration was not sent again.
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
    expect(audit.rows.map((r) => r.status)).toEqual(["blocked"]);
  });

  it("does not reissue the migration when the function is retried", async () => {
    // An Inngest retry replays the body from the top with the accumulated step
    // state. The completed call step must be read from that state, not redone.
    const model = scriptModel([
      toolCallResponse("call_1", "supabase__apply_migration", MIGRATION_ARGS),
      textResponse("Created the router_models table."),
    ]);
    const store = createApprovalStore();
    const audit = createAuditCollector();

    const callStepId =
      `mcp:supabase__apply_migration#${digestToolArgs(MIGRATION_ARGS)}#0:call`;

    const outcome = await drive(
      buildProcessMessageLike({ approvalGate: store.gate, audit: audit.sink }),
      model,
      // Retry the moment the migration itself has succeeded — the worst moment.
      { retryAfterStep: callStepId },
    );

    expect(outcome.finalType).toBe("function-resolved");
    // Proof the retry was actually exercised at the intended point.
    expect(outcome.stepIds).toContain(callStepId);
    expect(outcome.attempts).toBeGreaterThan(0);

    expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
    expect(store.inserts).toHaveLength(1);
    expect(audit.rows).toHaveLength(1);
  });
});

/** Narrow the mock's recorded arguments to the shape the assertions want. */
function mcpToolCalls() {
  return mocks.callMcpTool.mock.calls.map(
    ([arg]) => arg as { toolName: string; args: Record<string, unknown> },
  );
}
