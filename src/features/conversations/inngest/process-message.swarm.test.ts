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

import { inngest } from "@/inngest/client";
import { mergeMessageSteps } from "../../../../convex/messageSteps";
import type { AgentStep } from "../agent-steps";
import { swarmHeader, swarmSoloReason } from "../swarm-status";
import { BUILD_NOT_BUILT_NOTE } from "./build-check-gate";
import { SWARM_DELEGATE_NUDGE, SWARM_ORCHESTRATOR_NOTE } from "./constants";
import { FOUNDATION_MAX_STEPS } from "../constants";
import { drive, text, toolCall } from "./process-message.driver";

let swarmEnabled: boolean;
let projectFiles: Array<Record<string, unknown>>;
let recentMessages: Array<Record<string, unknown>>;

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => recentMessages,
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => projectFiles,
  "system:getProjectFilesWithUrls": () => [],
  "system:getEnvVarsForSandbox": () => [],
  "system:getProjectSkills": () => [],
  "swarm:getSwarmSettings": () => ({ enabled: swarmEnabled, platformMaxDepth: 2 }),
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
const TIMED_OUT = new Error("Timed out waiting for the invoked function");

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
/** The tool_choice of every forced request, in order. */
const forcedRequests = (bodies: unknown[]) =>
  (bodies as Array<{ tool_choice?: unknown }>).map((body) => body.tool_choice).filter((choice) => choice && typeof choice === "object");
const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const PIZZERIA = "Build a pizzeria site with home, menu, about and contact pages";

const swarm = (inferences: Parameters<typeof drive>[1], invokeResults: unknown[], cancelWhen?: () => boolean, prompt = PIZZERIA) =>
  drive({ modelId: "x-ai/grok-4.7" }, inferences, prompt, { mode: "swarm", ownerId: "user_1" }, {
    invokeResults,
    cancelWhen,
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  swarmEnabled = true;
  projectFiles = [];
  recentMessages = [];
  vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockImplementation(async (ref, args) => MUTATIONS[getFunctionName(ref)]?.(args) ?? null);
});

describe("processMessage swarm mode", () => {
  it("delegates once, checks the build and completes on the workers' writes alone", async () => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("checkBuild") },
      { data: text("**What was built:** a site.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.tools?.map((tool) => tool.function.name)).toContain("delegateTasks");
    expect(String(first.messages[0].content)).toContain("## Swarm mode");
    // The orchestrator sees the real multi-page request, and no blanket "too small to split" escape hatch.
    expect(JSON.stringify(first.messages)).toContain(PIZZERIA);
    expect(String(first.messages[0].content)).toContain("never too small to split");
    expect(String(first.messages[0].content)).not.toContain("If the work is too small to split");

    expect(mutationArgs("agentTasks:createTasks")).toEqual([expect.objectContaining({
      messageId: "m1",
      projectId: "p1",
      tasks: [
        expect.objectContaining({ taskId: "pages", role: "worker", ownedPaths: ["src/pages"], modelId: expect.any(String) }),
        expect.objectContaining({ taskId: "nav", role: "worker", ownedPaths: ["src/components/nav.tsx"] }),
      ],
    })]);
    // Each owned path's parent folders exist before any worker starts; the path itself is its owner's.
    expect(mutationArgs("system:createFolder").map(({ name }) => name)).toEqual(["src", "components"]);
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
    // Worker writes are the run's writes: with no sandbox to build in, the reply says it's unverified.
    expect(mutationArgs("system:createFiles")).toEqual([]);
    expect(String(mutationArgs("system:updateMessageContent").at(-1)?.content)).toContain(BUILD_NOT_BUILT_NOTE);
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

  it("delegates a plan with a detailed 5000-character brief (#646)", async () => {
    const brief = `Build the home page. ${"Match the dental clinic's tone and layout. ".repeat(120)}`.slice(0, 4999) + ".";
    const plan = { tasks: [{ ...PLAN.tasks[0], brief }, PLAN.tasks[1]] };
    const outcome = await swarm([
      { data: toolCall("delegateTasks", plan) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(mutationArgs("agentTasks:createTasks")[0].tasks).toEqual([
      expect.objectContaining({ taskId: "pages", brief }),
      expect.objectContaining({ taskId: "nav" }),
    ]);
    expect(outcome.invocations).toHaveLength(2);
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

  it.each([{ tasks: [] }, { tasks: [PLAN.tasks[0]] }])("returns an Error to the model for too few tasks (%j)", async ({ tasks }) => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", { tasks }) },
      { data: text("I need a valid delegation plan.") },
    ], []);

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolResults(outcome.inferenceBodies)[0]).toBe(
      "Error: Delegate 2-4 tasks, or pass tasks [] with solo set to why this is too tiny to split",
    );
    expect(mutationArgs("agentTasks:createTasks")).toEqual([]);
    expect(outcome.invocations).toEqual([]);
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

  it.each(["worker", "sub-orchestrator"])("reports a timed-out %s as failed, stops it, and the integrator writes its files", async (role) => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", { tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], role }] }) },
      { data: toolCall("writeFiles", { files: [{ path: "src/components/nav.tsx", content: "export const Nav = () => null;\n" }] }) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, TIMED_OUT]);

    expect(outcome.finalType).toBe("function-resolved");
    const [report, write] = toolResults(outcome.inferenceBodies);
    expect(report).toContain("## pages: Pages (done)");
    expect(report).toContain("## nav: Navigation (failed)\nTimed out waiting for the invoked function\nFinish it yourself; it owned src/components/nav.tsx.");
    // The integrator's writes are not ownership-guarded.
    expect(write).not.toMatch(/^Error/);
    expect(mutationArgs("system:createFiles")).toHaveLength(1);
    // It would keep writing after the integration build otherwise; its cancel skips onFailure.
    expect(inngest.send).toHaveBeenCalledWith([{ name: "agent-task/cancel", data: { agentTaskId: "task_1" } }]);
    expect(mutationArgs("agentTasks:finishTask")).toEqual([expect.objectContaining({ agentTaskId: "task_1", status: "error" })]);
  });

  it("returns an Error, not a write, when no worker wrote anything", async () => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: toolCall("checkBuild") },
      { data: text("Nothing was built.") },
    ], [{ status: "error", summary: "The task no longer exists.", writtenPaths: [] }, TIMED_OUT]);

    expect(outcome.finalType).toBe("function-resolved");
    const [report] = toolResults(outcome.inferenceBodies);
    expect(report).toMatch(/^Error: No worker wrote any files; build these tasks yourself\./);
    expect(report).toContain("## pages: Pages (failed)\nThe task no longer exists.");
    // Not a write: no build note, and a swarm that wrote nothing completes no first build (#338).
    expect(String(mutationArgs("system:updateMessageContent").at(-1)?.content)).toBe("Nothing was built.");
    expect(mutationArgs("projects:completeFirstBuild")).toEqual([]);
  });

  it("refuses a plan under a user-locked folder before creating tasks, so the model can re-plan", async () => {
    projectFiles = [{ _id: "d1", name: "src", type: "folder", locked: true }];
    const outcome = await swarm([
      { data: toolCall("delegateTasks", PLAN) },
      { data: text("src is locked, so I left it alone.") },
    ], []);

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolResults(outcome.inferenceBodies)[0]).toMatch(/^Error: src\/pages is locked by the user\..* Re-plan without it\.$/);
    expect(mutationArgs("system:createFolder")).toEqual([]);
    expect(mutationArgs("agentTasks:createTasks")).toEqual([]);
    expect(outcome.invocations).toEqual([]);
  });

  it("runs as a normal build when the kill switch turned swarm off after the send", async () => {
    swarmEnabled = false;
    const outcome = await swarm([{ data: text("Hi.") }], []);

    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.tools?.map((tool) => tool.function.name)).not.toContain("delegateTasks");
    expect(String(first.messages[0].content)).not.toContain("## Swarm mode");
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
    const queries: Record<string, () => unknown> = { ...QUERIES, "swarm:getSwarmSettings": () => ({ enabled: true, platformMaxDepth: 1 }) };
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
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [DONE, NAV_DONE]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolResults(outcome.inferenceBodies)[0])
      .toBe("Error: another swarm is already running for this account; build this one yourself.");
    expect(outcome.invocations).toEqual([]);
  });

  it.each([
    ["one-line copy change", "one-line copy change"],
    [`  ${"x".repeat(201)}  `, "x".repeat(200)],
  ])("keeps a tiny prompt solo with the classifier's reason, records its own (%s), and forces nothing", async (solo, expected) => {
    const outcome = await swarm([
      { data: toolCall("delegateTasks", { tasks: [], solo }) },
      { data: toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: "export default () => null;\n" }] }) },
      { data: toolCall("checkBuild") },
      { data: text("Done.") },
    ], [], undefined, "Change the hero title to Hello");

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolResults(outcome.inferenceBodies)[0]).toBe("Building solo: build it yourself, then run checkBuild.");
    expect(mutationArgs("agentTasks:createTasks")).toEqual([]);
    expect(outcome.invocations).toEqual([]);
    // Merged as Convex stores them: the finish record keeps the call's recorded targets.
    const steps = mutationArgs("system:upsertMessageSteps")
      .reduce<AgentStep[]>((all, { steps }) => mergeMessageSteps(all, steps as AgentStep[]), []);
    expect(steps.find((step) => step.tool === "delegateTasks")?.targets).toEqual([expected]);
    // The board's reason is the classifier's, decided before the run.
    expect(swarmSoloReason(steps)).toBe("a small edit");
    expect(swarmHeader([], 0, 5000, swarmSoloReason(steps))).toBe("Swarm · Built solo: a small edit · 0:05");
    expect(forcedRequests(outcome.inferenceBodies)).toEqual([]);
  });

  it("keeps a tiny follow-up to a completed reply solo", async () => {
    recentMessages = [
      { _id: "u0", role: "user", content: PIZZERIA },
      { _id: "a0", role: "assistant", content: "Built the site.", status: "completed" },
      { _id: "u1", role: "user", content: "change the button color to red" },
      { _id: "m1", role: "assistant", content: "", status: "processing" },
    ];
    const outcome = await swarm([
      { data: toolCall("writeFiles", { files: [{ path: "src/components/button.tsx", content: `export const B = () => <button>${"x".repeat(300)}</button>;\n` }] }) },
      { data: text("Done.") },
    ], [], undefined, "change the button color to red");

    expect(toolResults(outcome.inferenceBodies)[0]).not.toMatch(/^Error/);
    expect(forcedRequests(outcome.inferenceBodies)).toEqual([]);
    const steps = mutationArgs("system:upsertMessageSteps").flatMap(({ steps }) => steps as AgentStep[]);
    expect(swarmSoloReason(steps)).toBe("a small edit");
  });

  describe("a split request (the classifier says delegate)", () => {
    const FOUNDATION = toolCall("writeFiles", { files: [
      { path: "src/App.tsx", content: "import Home from './pages/home';\nexport default Home;\n" },
      // A one-line placeholder the pages worker overwrites, so App.tsx's import resolves meanwhile.
      { path: "src/pages/home.tsx", content: "export default () => null;\n" },
    ] });
    const PAGE = toolCall("writeFiles", { files: [{ path: "src/pages/menu.tsx", content: `export default () => <main>${"x".repeat(300)}</main>;\n` }] });
    const OVERLAP = { tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], ownedPaths: ["src/pages/nav.tsx"] }] };

    it("caps the foundation at 5 steps, then forces delegation", async () => {
      expect(FOUNDATION_MAX_STEPS).toBe(5);
      const outcome = await swarm([
        ...Array.from({ length: 5 }, () => ({ data: FOUNDATION })),
        { data: toolCall("delegateTasks", PLAN) },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], [DONE, NAV_DONE]);

      expect(outcome.finalType).toBe("function-resolved");
      const requests = codingRequests(outcome.inferenceBodies);
      expect(JSON.stringify(requests.slice(0, 5))).not.toContain(SWARM_DELEGATE_NUDGE);
      expect(JSON.stringify(requests[5].messages)).toContain(SWARM_DELEGATE_NUDGE);
      expect(forcedRequests(outcome.inferenceBodies)).toEqual([{ type: "function", function: { name: "delegateTasks" } }]);
      expect(outcome.invocations).toHaveLength(2);
    });

    it("requests a minimal foundation and balanced page tasks", () => {
      expect(SWARM_ORCHESTRATOR_NOTE).toContain("minimal shared foundation");
      expect(SWARM_ORCHESTRATOR_NOTE).toContain("at most 240 characters");
      expect(SWARM_ORCHESTRATOR_NOTE).toContain("No page content or sitemap/robots/favicon extras");
      expect(SWARM_ORCHESTRATOR_NOTE).toContain("at most 2 pages");
      expect(SWARM_ORCHESTRATOR_NOTE).toContain("UI primitives/layout may be their own small task");
    });

    it("refuses a page write before delegation, then forces delegateTasks, which runs the workers", async () => {
      const outcome = await swarm([
        { data: FOUNDATION },
        { data: PAGE },
        { data: toolCall("delegateTasks", PLAN) },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], [DONE, NAV_DONE]);

      expect(outcome.finalType).toBe("function-resolved");
      const [foundation, page, report] = toolResults(outcome.inferenceBodies);
      expect(foundation).not.toMatch(/^Error/);
      expect(page).toBe("Error: Swarm mode: src/pages/menu.tsx belongs to a worker. Call delegateTasks now with 2-4 tasks that own it.");
      expect(report).toContain("## pages: Pages (done)");
      // Only the third call was forced, on the OpenAI-compatible route, with the nudge.
      expect(forcedRequests(outcome.inferenceBodies)).toEqual([{ type: "function", function: { name: "delegateTasks" } }]);
      expect(JSON.stringify(codingRequests(outcome.inferenceBodies)[2].messages)).toContain(SWARM_DELEGATE_NUDGE);
      expect(mutationArgs("agentTasks:createTasks")[0].tasks).toHaveLength(2);
    });

    it("classifies Stop then \"continue\" on the stopped request, so it still delegates", async () => {
      recentMessages = [
        { _id: "u0", role: "user", content: PIZZERIA },
        { _id: "a0", role: "assistant", content: "", status: "cancelled" },
        { _id: "u1", role: "user", content: "continue" },
        { _id: "m1", role: "assistant", content: "", status: "processing" },
      ];
      const outcome = await swarm([
        { data: FOUNDATION },
        { data: PAGE },
        { data: toolCall("delegateTasks", PLAN) },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], [DONE, NAV_DONE], undefined, "continue");

      expect(outcome.finalType).toBe("function-resolved");
      expect(toolResults(outcome.inferenceBodies)[1]).toMatch(/^Error: Swarm mode: src\/pages\/menu.tsx belongs to a worker/);
      expect(forcedRequests(outcome.inferenceBodies)).toHaveLength(1);
      expect(mutationArgs("agentTasks:createTasks")).toHaveLength(1);
    });

    it("builds solo with the reason, and completes, when the forced turn's request fails", async () => {
      const outcome = await swarm([
        { data: FOUNDATION },
        { data: PAGE },
        { error: { name: "Error", message: "400 tool_choice forced is not compatible with thinking" } },
        { data: PAGE },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], []);

      expect(outcome.finalType).toBe("function-resolved");
      // The page write after the fallback goes through.
      expect(toolResults(outcome.inferenceBodies).at(-2)).not.toMatch(/^Error/);
      expect(mutationArgs("agentTasks:createTasks")).toEqual([]);
      const steps = mutationArgs("system:upsertMessageSteps")
        .reduce<AgentStep[]>((all, { steps }) => mergeMessageSteps(all, steps as AgentStep[]), []);
      expect(swarmSoloReason(steps)).toMatch(/^delegation failed \(.*tool_choice/);
    });

    it("refuses a placeholder over a file that already exists", async () => {
      projectFiles = [
        { _id: "d1", name: "src", type: "folder" },
        { _id: "d2", name: "pages", type: "folder", parentId: "d1" },
        { _id: "f1", name: "home.tsx", type: "file", parentId: "d2" },
      ];
      const outcome = await swarm([
        { data: FOUNDATION },
        { data: toolCall("delegateTasks", PLAN) },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], [DONE, NAV_DONE]);

      expect(outcome.finalType).toBe("function-resolved");
      expect(toolResults(outcome.inferenceBodies)[0])
        .toBe("Error: Swarm mode: src/pages/home.tsx already exists, so it belongs to a worker; placeholders are for new files only. Call delegateTasks now with 2-4 tasks that own it.");
      expect(mutationArgs("system:createFiles")).toEqual([]);
    });

    it("forces delegateTasks when the orchestrator would end without delegating", async () => {
      const outcome = await swarm([
        { data: FOUNDATION },
        { data: text("All done.") },
        { data: toolCall("delegateTasks", PLAN) },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], [DONE, NAV_DONE]);

      expect(outcome.finalType).toBe("function-resolved");
      expect(forcedRequests(outcome.inferenceBodies)).toHaveLength(1);
      expect(outcome.invocations).toHaveLength(2);
    });

    it("refuses a solo call, and forces once more after an invalid forced plan", async () => {
      const outcome = await swarm([
        { data: toolCall("delegateTasks", { tasks: [], solo: "small enough" }) },
        { data: toolCall("delegateTasks", OVERLAP) },
        { data: toolCall("delegateTasks", PLAN) },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], [DONE, NAV_DONE]);

      expect(outcome.finalType).toBe("function-resolved");
      const [solo, invalid, report] = toolResults(outcome.inferenceBodies);
      expect(solo).toMatch(/^Error: Swarm mode: this request is split among workers \(it names 4 pages or features/);
      expect(invalid).toMatch(/^Error: Owned paths overlap/);
      expect(report).toContain("(done)");
      expect(forcedRequests(outcome.inferenceBodies)).toHaveLength(2);
    });

    it("builds solo, with the refusal as the board's reason, after two invalid forced plans", async () => {
      const outcome = await swarm([
        { data: FOUNDATION },
        { data: PAGE },
        { data: toolCall("delegateTasks", OVERLAP) },
        { data: toolCall("delegateTasks", OVERLAP) },
        { data: PAGE },
        { data: toolCall("checkBuild") },
        { data: text("Done.") },
      ], []);

      expect(outcome.finalType).toBe("function-resolved");
      const results = toolResults(outcome.inferenceBodies);
      // The page write after the fallback goes through.
      expect(results[4]).not.toMatch(/^Error/);
      expect(forcedRequests(outcome.inferenceBodies)).toHaveLength(2);
      expect(mutationArgs("agentTasks:createTasks")).toEqual([]);
      const steps = mutationArgs("system:upsertMessageSteps")
        .reduce<AgentStep[]>((all, { steps }) => mergeMessageSteps(all, steps as AgentStep[]), []);
      expect(swarmSoloReason(steps)).toMatch(/^Owned paths overlap between pages and nav/);
    });
  });

  it("offers no delegateTasks and no swarm note outside swarm mode", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [{ data: text("Hi.") }], "Hi", { ownerId: "user_1" });

    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.tools?.map((tool) => tool.function.name)).not.toContain("delegateTasks");
    expect(String(first.messages[0].content)).not.toContain("## Swarm mode");
  });
});
