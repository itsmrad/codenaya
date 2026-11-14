/**
 * Swarm mode in a real `processMessage` run: the orchestrator delegates once
 * through delegateTasks (workers are canned `step.invoke` results), then
 * integrates, checks the build and completes like any build run.
 */

import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query), mutation: mocks.mutation } };
});

import { withEnvPlatform } from "@/features/ai-providers/server/active-platform.mock";

import { drive, text, toolCall } from "./process-message.driver";

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectFilesWithUrls": () => [],
  "system:getEnvVarsForSandbox": () => [],
  "system:getProjectSkills": () => [],
  "swarm:getSwarmSettings": () => ({ platformMaxDepth: 2 }),
};

const MUTATIONS: Record<string, (args: Record<string, unknown>) => unknown> = {
  "agentTasks:createTasks": ({ tasks }) => (tasks as unknown[]).map((_, i) => `task_${i}`),
  "system:createFolder": ({ name }) => `folder_${name}`,
  "system:createFiles": ({ files }) => (files as { name: string }[]).map(({ name }) => ({ name, fileId: `f_${name}` })),
};

const PLAN = {
  tasks: [
    { id: "pages", title: "Pages", brief: "Build the home page.", ownedPaths: ["src/pages/"] },
    { id: "nav", title: "Navigation", brief: "Build the nav bar.", ownedPaths: ["src/components/nav.tsx"] },
  ],
};
const DONE = { status: "done", summary: "Built the pages.\nNEEDS: add react-router-dom", writtenPaths: ["src/pages/home.tsx"] };
const NAV_DONE = { status: "done", summary: "Built the nav.", writtenPaths: ["src/components/nav.tsx"] };
const writeApp = toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: "export default () => null;\n" }] });

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);
/** The tool results the orchestrator saw, in order. */
const toolResults = (bodies: unknown[]) =>
  (codingRequests(bodies).at(-1)?.messages ?? []).filter((m) => m.role === "tool")
    .map((m) => String((JSON.parse(String(m.content)) as { data: unknown }).data));
const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const swarm = (inferences: Parameters<typeof drive>[1], invokeResults: unknown[], cancelWhen?: () => boolean) =>
  drive({ modelId: "x-ai/grok-4.7" }, inferences, "Build a site", { mode: "swarm", ownerId: "user_1" }, {
    invokeResults,
    cancelWhen,
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockImplementation(async (ref, args) => MUTATIONS[getFunctionName(ref)]?.(args) ?? null);
});

describe("processMessage swarm mode", () => {
  it("delegates once, integrates the reports, checks the build and completes", async () => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: writeApp },
      { data: toolCall("checkBuild") },
      { data: text("**What was built:** a site.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.tools?.map((tool) => tool.function.name)).toContain("delegateTasks");
    expect(String(first.messages[0].content)).toContain("## Swarm mode");

    expect(mutationArgs("agentTasks:createTasks")).toEqual([expect.objectContaining({
      messageId: "m1",
      projectId: "p1",
      tasks: PLAN.tasks.map((task) => expect.objectContaining({
        taskId: task.id, role: "worker", ownedPaths: task.ownedPaths.map((path) => path.replace(/\/$/, "")), modelId: expect.any(String),
      })),
    })]);
    // Every owned path's parent folder exists before any worker starts (the mock's file list never gains them).
    expect(mutationArgs("system:createFolder").map(({ name }) => name).slice(0, 2)).toEqual(["src", "components"]);
    expect(outcome.invocations).toEqual([
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "task_0", parentMessageId: "m1", ownerId: "user_1" }) }, timeout: "12m" }),
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "task_1" }) } }),
    ]);

    const [report] = toolResults(outcome.inferenceBodies);
    expect(report).toContain("## pages: Pages (done)\nFiles written: src/pages/home.tsx");
    expect(report).toContain("NEEDS: add react-router-dom");
    expect(report).toContain("## nav: Navigation (done)");
    // The run block counts one target per task.
    const recorded = mutationArgs("system:upsertMessageSteps").flatMap(({ steps }) => steps as Array<{ tool?: string; targets?: string[] }>);
    expect(recorded.find((step) => step.tool === "delegateTasks")?.targets).toEqual(["Pages", "Navigation"]);
    // Worker writes count as the run's writes (#338).
    expect(mutationArgs("projects:completeFirstBuild")).toHaveLength(1);
  });

  it("runs a sub-orchestrator on Sonnet beside a worker, with room for its own workers", async () => {
    mocks.query.mockImplementation(withEnvPlatform(async (ref) => QUERIES[getFunctionName(ref)]?.(), () => ({
      models: ["x-ai/grok-4.7", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"].map((id) => ({
        id, name: id, vendor: "a", provider: "openrouter", providerModelId: id, vision: false, tools: "reported",
        pricing: { mode: "blended", usdPerMTok: 1 }, access: "everyone", hidden: id !== "x-ai/grok-4.7",
      })),
      defaultModelId: "x-ai/grok-4.7",
      utilityModelId: "x-ai/grok-4.7",
    })));
    const plan = { tasks: [{ ...PLAN.tasks[0], role: "sub-orchestrator" }, PLAN.tasks[1]] };
    const outcome = await swarm([
      { data: toolCall("delegateTasks", plan) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [{ ...DONE, writtenPaths: ["src/pages/home.tsx", "src/pages/about.tsx"] }, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(mutationArgs("agentTasks:createTasks")[0].tasks).toEqual([
      expect.objectContaining({ taskId: "pages", role: "sub-orchestrator", modelId: "anthropic/claude-sonnet-5.5" }),
      expect.objectContaining({ taskId: "nav", role: "worker", modelId: "anthropic/claude-haiku-5.5" }),
    ]);
    expect(outcome.invocations).toEqual([
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "task_0", depth: 1 }) }, timeout: "25m" }),
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "task_1", depth: 1 }) }, timeout: "12m" }),
    ]);
    expect(toolResults(outcome.inferenceBodies)[0]).toContain("Files written: src/pages/home.tsx, src/pages/about.tsx");
  });

  it("returns an invalid plan as an Error to re-plan, then runs the valid one", async () => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", { tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], ownedPaths: ["src/pages/nav.tsx"] }] }) },
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    const [invalid, valid] = toolResults(outcome.inferenceBodies);
    expect(invalid).toMatch(/^Error: Owned paths overlap between pages and nav/);
    expect(valid).toContain("(done)");
    expect(mutationArgs("agentTasks:createTasks")).toHaveLength(1);
  });

  it("refuses a second delegateTasks call", async () => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolResults(outcome.inferenceBodies)[1]).toBe("Error: already delegated, integrate now.");
    expect(outcome.invocations).toHaveLength(2);
  });

  it("reports a failed worker so the integrator writes its files", async () => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("writeFiles", { files: [{ path: "src/components/nav.tsx", content: "export const Nav = () => null;\n" }] }) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, new Error("Timed out waiting for the invoked function")]);

    expect(outcome.finalType).toBe("function-resolved");
    const [report, write] = toolResults(outcome.inferenceBodies);
    expect(report).toContain("## pages: Pages (done)");
    expect(report).toContain("## nav: Navigation (failed)\nTimed out waiting for the invoked function\nFinish it yourself; it owned src/components/nav.tsx.");
    // The integrator's writes are not ownership-guarded.
    expect(write).not.toMatch(/^Error/);
    expect(mutationArgs("system:createFiles")).toHaveLength(1);
  });

  it("stops when cancelled during delegation, before any worker result", async () => {
    const outcome = await swarm(
      [{ data: toolCall("delegateTasks", PLAN) }, { data: text("Done.") }],
      [DONE, NAV_DONE],
      () => mutationArgs("agentTasks:createTasks").length > 0,
    );

    expect(outcome.finalType).toBe("cancelled");
    expect(outcome.invocations).toEqual([]);
    expect(mutationArgs("system:updateMessageContent")).toEqual([]);
  });

  it("keeps a platform swarm at depth 1 unless SWARM_PLATFORM_MAX_DEPTH allows sub-orchestrators", async () => {
    const queries: Record<string, () => unknown> = { ...QUERIES, "swarm:getSwarmSettings": () => ({ platformMaxDepth: 1 }) };
    mocks.query.mockImplementation(async (ref) => queries[getFunctionName(ref)]?.());
    const plan = { tasks: [{ ...PLAN.tasks[0], role: "sub-orchestrator" }, PLAN.tasks[1]] };
    const outcome = await swarm([
      { data: toolCall("delegateTasks", plan) },
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    const [first] = codingRequests(outcome.inferenceBodies);
    expect(String(first.messages[0].content)).toContain("## Swarm mode");
    expect(String(first.messages[0].content)).not.toContain("sub-orchestrator");
    expect(toolResults(outcome.inferenceBodies)[0]).toMatch(/^Error: Sub-orchestrators are off for this run/);
    expect(mutationArgs("agentTasks:createTasks")).toEqual([expect.objectContaining({ byok: false })]);
  });

  it("builds alone when another platform swarm of the owner's is running", async () => {
    mocks.mutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === "agentTasks:createTasks") {
        throw new ConvexError({ code: "CONFLICT", message: "Another swarm is already running for this account" });
      }
      return MUTATIONS[getFunctionName(ref)]?.(args) ?? null;
    });
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: writeApp },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolResults(outcome.inferenceBodies)[0])
      .toBe("Error: another swarm is already running for this account; build this one yourself.");
    expect(outcome.invocations).toEqual([]);
  });

  it("offers no delegateTasks and no swarm note outside swarm mode", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [{ data: text("Hi.") }], "Hi", { ownerId: "user_1" });

    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.tools?.map((tool) => tool.function.name)).not.toContain("delegateTasks");
    expect(String(first.messages[0].content)).not.toContain("## Swarm mode");
  });
});
