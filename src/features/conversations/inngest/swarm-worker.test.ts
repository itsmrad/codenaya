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
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.catalog), mutation: mocks.mutation } };
});

import { TURN_HEARTBEAT_ID } from "../agent-steps";
import { WORKER_MAX_STEPS } from "../swarm";
import { drive, text, toolCall } from "./process-message.driver";
import { swarmWorker } from "./swarm-worker";

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

const run = (inferences: Parameters<typeof drive>[1]) =>
  drive({ modelId: "x-ai/grok-4.7" }, inferences, "", {
    parentMessageId: "m1",
    agentTaskId: "t1",
    ownerId: "user_1",
    planOverview: "## Plan\n- pages: home page\n- nav: navigation",
  }, { fn: swarmWorker });

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const taskSteps = () =>
  mutationArgs("agentTasks:upsertTaskSteps").flatMap(({ steps }) => steps as Array<{ id: string; status: string; error?: string }>);

const withUsage = (body: object) => ({ ...body, usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } });

beforeEach(() => {
  vi.resetAllMocks();
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
  }, 20_000);

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

  it("is cancelled with its parent message or on its own timeout, with room for two swarms' workers per owner", () => {
    const { opts } = swarmWorker as unknown as { opts: { cancelOn: unknown; concurrency: unknown } };
    expect(opts.cancelOn).toEqual([
      { event: "message/cancel", if: "event.data.parentMessageId == async.data.messageId" },
      { event: "agent-task/cancel", if: "event.data.agentTaskId == async.data.agentTaskId" },
    ]);
    expect(opts.concurrency).toEqual([{ key: "event.data.ownerId", limit: 8 }]);
  });
});
