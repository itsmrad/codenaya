/**
 * A swarm worker run alone under the driver: it writes only its owned paths,
 * meters usage against its task, keeps the parent's heartbeat fresh, and hands
 * off to the summary agent at its step or cost cap.
 */

import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  catalog: vi.fn(),
  account: vi.fn(),
  selfCheckWorker: vi.fn(),
}));

vi.mock("../swarm-sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../swarm-sandbox")>()),
  selfCheckWorker: mocks.selfCheckWorker,
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.catalog, mocks.account), mutation: mocks.mutation } };
});

import { TURN_HEARTBEAT_ID } from "../agent-steps";
import { WORKER_MAX_STEPS } from "../swarm";
import { drive, text, toolCall } from "./process-message.driver";
import { swarmWorker } from "./swarm-worker";
import { createDelegateTasksTool } from "./tools/delegate-tasks";

const TASK = {
  taskId: "pages",
  title: "Pages",
  brief: "Build the home page.",
  ownedPaths: ["src/pages/"],
  modelId: "anthropic/claude-haiku-5.5",
  model: "Claude Haiku 5.5",
  messageId: "m1",
  projectId: "p1",
  status: "running",
};

const MUTATIONS: Record<string, (args: Record<string, unknown>) => unknown> = {
  "agentTasks:startTask": () => TASK,
  "system:createFolder": () => "folder_1",
  "system:createFiles": ({ files }) => (files as { name: string }[]).map(({ name }) => ({ name, fileId: `f_${name}` })),
};

const run = (inferences: Parameters<typeof drive>[1], extra: Record<string, unknown> = {}, invokeResults: unknown[] = []) =>
  drive({ modelId: "x-ai/grok-4.7" }, inferences, "", {
    parentMessageId: "m1",
    agentTaskId: "t1",
    ownerId: "user_1",
    planOverview: "## Plan\n- pages: home page\n- nav: navigation",
    ...extra,
  }, { fn: swarmWorker, invokeResults });

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const taskSteps = () =>
  mutationArgs("agentTasks:upsertTaskSteps").flatMap(({ steps }) => steps as Array<{ id: string; status: string; error?: string }>);

const withUsage = (body: object) => ({ ...body, usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  mocks.query.mockImplementation(async (ref) =>
    ["system:getProjectFiles", "system:getProjectFilesWithUrls"].includes(getFunctionName(ref)) ? [] : null);
  mocks.mutation.mockImplementation(async (ref, args) => MUTATIONS[getFunctionName(ref)]?.(args) ?? null);
});

describe("swarmWorker", () => {
  it("writes its owned file, refuses an outside write, and reports what it wrote", async () => {
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content: "export default () => null;\n" }] }) },
      { data: toolCall("editFile", { path: "src/App.tsx", edits: [{ oldText: "a", newText: "b" }] }) },
      { data: withUsage(text("Built the home page.\nNEEDS: route /home in src/App.tsx")) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.data).toEqual({
      status: "done",
      summary: "Built the home page.\nNEEDS: route /home in src/App.tsx",
      writtenPaths: ["src/pages/home.tsx"],
    });
    const steps = taskSteps();
    expect(steps).toContainEqual(expect.objectContaining({ id: "call_writeFiles", status: "done" }));
    expect(steps).toContainEqual(expect.objectContaining({
      id: "call_editFile", status: "error", error: expect.stringMatching(/Write refused/),
    }));
    expect(mutationArgs("system:updateFile")).toHaveLength(0);

    const [request] = outcome.inferenceBodies as Array<{
      messages: Array<{ content: string }>;
      tools: Array<{ function: { name: string } }>;
    }>;
    // Path-based tools only: no rename, move, id-based writes, build, env or MCP.
    expect(request.tools.map((tool) => tool.function.name).sort()).toEqual(
      ["deleteFiles", "editFile", "listFiles", "readFiles", "searchFiles", "writeFiles"],
    );
    expect(request.messages[0].content).toContain("[swarm-worker]");
    expect(request.messages[0].content).toContain("Owned paths: src/pages/");
    expect(request.messages.at(-1)?.content).toBe(TASK.brief);

    expect(mutationArgs("agentTasks:startTask")[0]).toMatchObject({ agentTaskId: "t1", parentMessageId: "m1", projectId: "p1" });
    expect(mutationArgs("credits:recordRunUsage").at(-1)).toMatchObject({
      messageId: "m1", agentTaskId: "t1", source: "platform", inputTokens: 1_000, outputTokens: 1_000,
      modelId: "anthropic/claude-haiku-5.5", model: "Codenaya · anthropic/claude-haiku-5.5",
    });
    // Three turns in well under WORKER_HEARTBEAT_MS: one parent write.
    expect(mutationArgs("system:upsertMessageSteps")).toEqual([expect.objectContaining({
      messageId: "m1", steps: [expect.objectContaining({ id: TURN_HEARTBEAT_ID })],
    })]);
    expect(mutationArgs("agentTasks:finishTask")).toEqual([expect.objectContaining({ agentTaskId: "t1", status: "done" })]);
  });

  it("checks JSON-string array args against its owned paths like real ones", async () => {
    const outcome = await run([
      { data: toolCall("writeFiles", { files: JSON.stringify([{ path: "src/pages/home.tsx", content: "export default () => null;\n" }]) }) },
      { data: toolCall("deleteFiles", { paths: JSON.stringify(["src/App.tsx"]) }) },
      { data: withUsage(text("Built the home page.")) },
    ]);

    expect(outcome.data).toMatchObject({ status: "done", writtenPaths: ["src/pages/home.tsx"] });
    const steps = taskSteps();
    expect(steps).toContainEqual(expect.objectContaining({ id: "call_writeFiles", status: "done" }));
    expect(steps).toContainEqual(expect.objectContaining({
      id: "call_deleteFiles", status: "error", error: expect.stringMatching(/Write refused/),
    }));
    expect(mutationArgs("system:deleteFile")).toHaveLength(0);
  });

  it("hands its last step to the summary agent at the step cap", async () => {
    const outcome = await run([
      ...Array.from({ length: WORKER_MAX_STEPS - 1 }, () => ({ data: toolCall("listFiles") })),
      { data: text("Listed files; the page is unfinished.") },
    ]);

    expect(outcome.inferenceBodies).toHaveLength(WORKER_MAX_STEPS);
    const summary = "Unfinished (step or cost cap): Listed files; the page is unfinished.";
    expect(outcome.data).toMatchObject({ status: "unfinished", summary });
    expect(mutationArgs("agentTasks:finishTask")).toEqual([expect.objectContaining({ status: "done", summary })]);
  }, 20_000); // 20 replayed turns: ~2 s alone, past the 5 s default under the full suite

  it("hands off to the summary agent once its usage crosses the cost cap", async () => {
    mocks.catalog.mockReturnValue({
      models: [{
        id: "anthropic/claude-haiku-5.5", name: "Haiku", vendor: "a", provider: "openrouter",
        providerModelId: "anthropic/claude-haiku-5.5", vision: false, tools: "reported",
        pricing: { mode: "blended", usdPerMTok: 300 }, access: "everyone", hidden: true,
      }, {
        id: "x-ai/grok-4.7", name: "Grok", vendor: "x", provider: "openrouter",
        providerModelId: "x-ai/grok-4.7", vision: false, tools: "reported",
        pricing: { mode: "blended", usdPerMTok: 10 }, access: "everyone", hidden: false,
      }],
      defaultModelId: "x-ai/grok-4.7",
      utilityModelId: "x-ai/grok-4.7",
    });
    const outcome = await run([
      { data: withUsage(toolCall("listFiles")) }, // 2,000 tokens at $300/MTok: $0.60
      { data: text("Stopped at the budget.") },
    ]);

    expect(outcome.inferenceBodies).toHaveLength(2);
    expect(outcome.data).toMatchObject({ status: "unfinished" });
    expect(mutationArgs("credits:recordRunUsage")[0].costUsd).toBeCloseTo(0.6, 10);
  });

  it.each([
    { left: 0, final: false }, { left: 3, final: false }, { left: 4, final: false }, { left: 2, final: true },
  ])("stops at a $left-credit balance and preserves a final answer: $final", async ({ left, final }) => {
    vi.stubEnv("CREDIT_LIMITS_ENFORCED", "true");
    const now = Date.now();
    mocks.account.mockReturnValue({ plan: "free", periodStartsAt: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1),
      periodUsed: 60 - left, dayStartsAt: new Date(now).setUTCHours(0, 0, 0, 0), dayUsed: 60 - left });
    mocks.query.mockImplementation(async (ref) => getFunctionName(ref) === "system:getProjectById"
      ? { ownerId: "real_owner" } : []);
    mocks.catalog.mockReturnValue({
      models: [{
        id: "anthropic/claude-haiku-5.5", name: "Haiku", vendor: "a", provider: "openrouter",
        providerModelId: "anthropic/claude-haiku-5.5", vision: false, tools: "reported",
        pricing: { mode: "blended", usdPerMTok: 10 }, access: "everyone", hidden: false,
      }],
      defaultModelId: "anthropic/claude-haiku-5.5", utilityModelId: "anthropic/claude-haiku-5.5",
    });
    const outcome = await run([
      ...(left > 0 ? [{ data: withUsage(final ? text("The real final answer.") : toolCall("listFiles")) }] : []), // 3 credits
      ...(left > 3 ? [{ data: withUsage(toolCall("listFiles")) }] : []),
      ...(!final ? [{ data: text("Listed files; the task is unfinished.") }] : []),
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(final || left === 0 ? 1 : left === 3 ? 2 : 3);
    expect(outcome.data).toMatchObject({ status: final ? "done" : "unfinished", summary: expect.stringContaining("ran out of credits") });
    if (final) expect(outcome.data).toMatchObject({ summary: expect.stringContaining("The real final answer.") });
    if (!final) expect(JSON.stringify(outcome.inferenceBodies.at(-1))).toContain("ran out of credits");
    expect(mocks.account).toHaveBeenCalledTimes(1);
    expect(mocks.selfCheckWorker.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it("ends quietly when its task row is gone", async () => {
    MUTATIONS["agentTasks:startTask"] = () => {
      throw new ConvexError({ code: "NOT_FOUND", message: "Task not found" });
    };
    try {
      const outcome = await run([{ data: text("unused") }]);
      expect(outcome.data).toMatchObject({ status: "error", writtenPaths: [] });
      expect(outcome.inferenceBodies).toHaveLength(0);
      expect(mutationArgs("agentTasks:finishTask")).toHaveLength(0);
    } finally {
      MUTATIONS["agentTasks:startTask"] = () => TASK;
    }
  });

  it.each(["worker", "sub-orchestrator"])("meters %s repair turns cumulatively in separate durable steps and stops at its cost cap", async (role) => {
    MUTATIONS["agentTasks:startTask"] = () => ({ ...TASK, role });
    const modelId = role === "worker" ? "anthropic/claude-haiku-5.5" : "anthropic/claude-sonnet-5.5";
    mocks.catalog.mockReturnValue({
      models: [modelId, "x-ai/grok-4.7"].map((id) => ({
        id, name: id, vendor: "a", provider: "openrouter", providerModelId: id, vision: false, tools: "reported",
        pricing: { mode: "blended", usdPerMTok: 100 }, access: "everyone", hidden: id === modelId,
      })),
      defaultModelId: "x-ai/grok-4.7", utilityModelId: "x-ai/grok-4.7",
    });
    mocks.selfCheckWorker.mockImplementation(async ({ onResponse, signal }) => {
      expect(signal.aborted).toBe(false);
      await onResponse(JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 500 } }));
      expect(signal.aborted).toBe(false);
      await onResponse(JSON.stringify({ usage: { prompt_tokens: 10_000, completion_tokens: 10_000 } }));
      expect(signal.aborted).toBe(true);
      return { selfCheck: "skipped (cost budget)", filesChanged: [] };
    });
    try {
      const outcome = await run([{ data: withUsage(text("Built the page.")) }]);
      expect(outcome.finalType).toBe("function-resolved");
      const records = mutationArgs("credits:recordRunUsage");
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({ inputTokens: 1_000, outputTokens: 1_000, costUsd: 0.2 });
      expect(records[1]).toMatchObject({ inputTokens: 1_500, outputTokens: 1_500 });
      expect(records[1].costUsd).toBeCloseTo(0.3, 10);
      expect(records[2]).toMatchObject({
        messageId: "m1", agentTaskId: "t1", source: "platform", modelId,
        inputTokens: 11_500, outputTokens: 11_500, costUsd: 2.3,
      });
    } finally {
      MUTATIONS["agentTasks:startTask"] = () => TASK;
    }
  });

  it("is cancelled with its parent message or on its own timeout, with room for two swarms' agents per owner", () => {
    const { opts } = swarmWorker as unknown as { opts: { cancelOn: unknown; concurrency: unknown } };
    expect(opts.cancelOn).toEqual([
      { event: "message/cancel", if: "event.data.parentMessageId == async.data.messageId" },
      {
        event: "agent-task/cancel",
        if: "event.data.agentTaskId == async.data.agentTaskId || event.data.parentAgentTaskId == async.data.agentTaskId",
      },
    ]);
    // One cancelOn entry per event name.
    const events = (opts.cancelOn as Array<{ event: string }>).map(({ event }) => event);
    expect(new Set(events).size).toBe(events.length);
    expect(opts.concurrency).toEqual([{ key: "event.data.ownerId", limit: 16 }]);
  });
});

describe("swarmWorker as a sub-orchestrator", () => {
  const SUB = { ...TASK, taskId: "shop", title: "Shop", brief: "Build the shop.", ownedPaths: ["src/shop/"], role: "sub-orchestrator" };
  const CHILDREN = {
    tasks: [
      { id: "cart", title: "Cart", brief: "Build the cart.", ownedPaths: ["src/shop/cart/"] },
      { id: "list", title: "List", brief: "Build the product list.", ownedPaths: ["src/shop/list.tsx"] },
    ],
  };
  const CART = { status: "done", summary: "Built the cart.", writtenPaths: ["src/shop/cart/cart.tsx"] };
  const LIST = { status: "done", summary: "Built the list.", writtenPaths: ["src/shop/list.tsx"] };
  const PRICED = (id: string, usdPerMTok: number) => ({
    id, name: id, vendor: "a", provider: "openrouter", providerModelId: id, vision: false, tools: "reported",
    pricing: { mode: "blended", usdPerMTok }, access: "everyone", hidden: id !== "x-ai/grok-4.7",
  });

  beforeEach(() => {
    MUTATIONS["agentTasks:startTask"] = () => SUB;
    MUTATIONS["agentTasks:createTasks"] = ({ tasks }) => (tasks as unknown[]).map((_, i) => `child_${i}`);
    mocks.catalog.mockReturnValue({
      models: [PRICED("anthropic/claude-haiku-5.5", 2), PRICED("anthropic/claude-sonnet-5.5", 10), PRICED("x-ai/grok-4.7", 1)],
      defaultModelId: "x-ai/grok-4.7",
      utilityModelId: "x-ai/grok-4.7",
    });
    return () => {
      MUTATIONS["agentTasks:startTask"] = () => TASK;
      delete MUTATIONS["agentTasks:createTasks"];
    };
  });

  it("delegates inside its paths to depth-2 workers, integrates, and is billed at Sonnet", async () => {
    const outcome = await run([
      { data: withUsage(toolCall("delegateTasks", CHILDREN)) }, // 2,000 tokens at Sonnet's $10/MTok
      { data: toolCall("writeFiles", { files: [{ path: "src/shop/index.tsx", content: "export {};\n" }] }) },
      { data: text("Built the shop.") },
    ], {}, [CART, LIST]);

    expect(outcome.finalType).toBe("function-resolved");
    const [request] = outcome.inferenceBodies as Array<{ messages: Array<{ content: string }>; tools: Array<{ function: { name: string } }> }>;
    expect(request.tools.map((tool) => tool.function.name)).toContain("delegateTasks");
    expect(request.messages[0].content).toContain("[swarm-worker]");
    expect(request.messages[0].content).toContain("[swarm-suborchestrator]");

    expect(mutationArgs("agentTasks:createTasks")).toEqual([expect.objectContaining({
      messageId: "m1",
      tasks: [
        expect.objectContaining({ taskId: "shop/cart", parentTaskId: "shop", role: "worker", modelId: "anthropic/claude-haiku-5.5" }),
        expect.objectContaining({ taskId: "shop/list", parentTaskId: "shop", role: "worker" }),
      ],
    })]);
    // Children carry both parent ids, so message and sub-orchestrator cancellation reach them.
    expect(outcome.invocations).toEqual([
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "child_0", parentAgentTaskId: "t1", parentMessageId: "m1", ownerId: "user_1", depth: 2 }) }, timeout: "10m" }),
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "child_1", parentAgentTaskId: "t1", depth: 2 }) }, timeout: "10m" }),
    ]);
    expect(outcome.data).toMatchObject({
      status: "done",
      writtenPaths: ["src/shop/cart/cart.tsx", "src/shop/list.tsx", "src/shop/index.tsx"],
    });
    // Its own ledger row, at the sub-orchestrator's (Sonnet) price.
    expect(mutationArgs("credits:recordRunUsage")[0]).toMatchObject({ agentTaskId: "t1", messageId: "m1", modelId: "anthropic/claude-sonnet-5.5" });
    expect(mutationArgs("credits:recordRunUsage")[0].costUsd).toBeCloseTo(0.02, 10);
  });

  it("refuses children outside its paths and overlapping siblings", async () => {
    const outcome = await run([
      { data: toolCall("delegateTasks", { tasks: [CHILDREN.tasks[0], { ...CHILDREN.tasks[1], ownedPaths: ["src/pages/list.tsx"] }] }) },
      { data: toolCall("delegateTasks", { tasks: [CHILDREN.tasks[0], { ...CHILDREN.tasks[1], ownedPaths: ["src/shop/cart/x.tsx"] }] }) },
      { data: text("Built it myself.") },
    ]);

    const tool = (outcome.inferenceBodies.at(-1) as { messages: Array<{ role: string; content: string }> }).messages
      .filter((m) => m.role === "tool").map((m) => String((JSON.parse(m.content) as { data: unknown }).data));
    expect(tool[0]).toMatch(/outside your owned paths/);
    expect(tool[1]).toMatch(/overlap/);
    expect(outcome.invocations).toEqual([]);
  });

  it("builds it itself when the swarm is at its agent limit", async () => {
    MUTATIONS["agentTasks:createTasks"] = () => {
      throw new ConvexError({ code: "LIMIT_EXCEEDED", message: "Too many swarm agents" });
    };
    const outcome = await run([{ data: toolCall("delegateTasks", CHILDREN) }, { data: text("Built it myself.") }]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(JSON.stringify(outcome.inferenceBodies.at(-1))).toContain("already runs 8 agents");
    expect(outcome.invocations).toEqual([]);
  });

  it("offers no delegateTasks at depth 2", async () => {
    const outcome = await run([{ data: text("Done.") }], { depth: 2 });

    const [request] = outcome.inferenceBodies as Array<{ messages: Array<{ content: string }>; tools: Array<{ function: { name: string } }> }>;
    expect(request.tools.map((tool) => tool.function.name)).not.toContain("delegateTasks");
    expect(request.messages[0].content).not.toContain("[swarm-suborchestrator]");
  });

  it("refuses a depth-2 delegateTasks call", async () => {
    const tool = createDelegateTasksTool({
      internalKey: "ik", projectId: "p1" as never, messageId: "m1" as never, ownerId: "user_1", model: { modelId: "x" },
      parent: { taskId: "shop/cart", agentTaskId: "child_0" as never, ownedPaths: ["src/shop/cart/"], depth: 2 },
    });
    expect(await tool.handler(CHILDREN as never, {} as never)).toMatch(/^Error: Workers cannot delegate/);
  });
});

describe("swarm cancellation", () => {
  // The CEL `a == b || c == d` of cancelOn, with `event` the run's trigger and `async` the cancel event.
  const cancels = (data: Record<string, unknown>, cancel: Record<string, unknown>, event = "message/cancel") => {
    const { opts } = swarmWorker as unknown as { opts: { cancelOn: Array<{ event: string; if: string }> } };
    const value = (path: string) => path.split(".").slice(1)
      .reduce<unknown>((o, key) => (o as Record<string, unknown>)?.[key], { event: { data }, async: { data: cancel } }[path.split(".")[0]]);
    return opts.cancelOn.some((rule) => rule.event === event && rule.if.split(" || ").some((clause) => {
      const [left, right] = clause.split(" == ").map(value);
      return left !== undefined && left === right;
    }));
  };

  it("matches a top-level task and a sub-orchestrator's child alike, and no other message", () => {
    const top = { parentMessageId: "m1", agentTaskId: "t1", depth: 1 };
    const child = { parentMessageId: "m1", agentTaskId: "child_0", depth: 2 };
    expect(cancels(top, { messageId: "m1" })).toBe(true);
    expect(cancels(child, { messageId: "m1" })).toBe(true);
    expect(cancels(child, { messageId: "m2" })).toBe(false);
  });

  it("cancels a sub-orchestrator and its children without stopping sibling tasks", () => {
    const cancel = { agentTaskId: "t1" };
    const child = { parentMessageId: "m1", agentTaskId: "child_0", parentAgentTaskId: "t1", depth: 2 };
    expect(cancels({ agentTaskId: "t1" }, cancel, "agent-task/cancel")).toBe(true);
    expect(cancels(child, cancel, "agent-task/cancel")).toBe(true);
    expect(cancels({ ...child, agentTaskId: "child_1" }, cancel, "agent-task/cancel")).toBe(true);
    expect(cancels({ agentTaskId: "t2" }, cancel, "agent-task/cancel")).toBe(false);
    expect(cancels({ ...child, parentAgentTaskId: "t2" }, cancel, "agent-task/cancel")).toBe(false);
  });
});
