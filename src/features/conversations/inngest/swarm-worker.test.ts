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
  const { withEnvPlatform, withPlatformPermission } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.catalog, mocks.account), mutation: withPlatformPermission(mocks.mutation, mocks.account) } };
});

import { TURN_HEARTBEAT_ID } from "../agent-steps";
import { MAX_ORIGINAL_PROMPT_CHARS, WORKER_MAX_STEPS, capOriginalPrompt } from "../swarm";
import { WRITE_BATCH_FILES, WRITE_BATCH_LINES } from "./constants";
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
    siblingOwnedPaths: ["src/components/nav.tsx"],
    planOverview: "## Plan\n- pages: home page\n- nav: navigation",
    ...extra,
  }, { fn: swarmWorker, invokeResults });

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const taskSteps = () =>
  mutationArgs("agentTasks:upsertTaskSteps").flatMap(({ steps }) => steps as Array<{ id: string; status: string; error?: string }>);

/** The worker's system prompt as OpenRouter gets it for Claude: cacheable text blocks. */
type SystemBlock = { type: "text"; text: string; cache_control?: { type: string } };

const withUsage = (body: object) => ({ ...body, usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
  vi.stubEnv("CODENAYA_BILLING_ENABLED", "");
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  mocks.query.mockImplementation(async (ref) =>
    getFunctionName(ref) === "system:getProjectById" ? { ownerId: "user_1" } :
      ["system:getProjectFiles", "files:getBuildFiles"].includes(getFunctionName(ref)) ? [] : null);
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
      messages: Array<{ content: unknown }>;
      tools: Array<{ function: { name: string } }>;
    }>;
    // Path-based tools only: no rename, move, id-based writes, build, env or MCP.
    expect(request.tools.map((tool) => tool.function.name).sort()).toEqual(
      ["deleteFiles", "editFile", "listFiles", "readFiles", "searchFiles", "writeFiles"],
    );
    // The shared system block is cached; the task line follows it uncached.
    const [shared, taskLine, ...more] = request.messages[0].content as SystemBlock[];
    expect(more).toHaveLength(0);
    expect(shared).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(shared.text).toContain("[swarm-worker]");
    expect(shared.text).toContain(`as few writeFiles calls as you can, each at most ${WRITE_BATCH_FILES} files and about ${WRITE_BATCH_LINES} lines in all`);
    expect(shared.text).toContain("is cut off and writes NOTHING. editFile stays right for changes to existing files.");
    expect(shared.text).toContain("Read only files you must import from; shared types and stubs are listed in the tree.");
    expect(shared.text).toContain("Avoid per-file edit/read loops. Do not re-read what you wrote.");
    expect(shared.text).toContain("Do not run checkBuild or any build: the orchestrator integrates and checks the complete project.");
    expect(shared.text).toContain("Stop once your files are written. Finish with a one-line summary");
    expect(shared.text).not.toContain("Owned paths:");
    expect(taskLine).not.toHaveProperty("cache_control");
    expect(taskLine.text).toMatch(/^## Your task: .*\nOwned paths: src\/pages\/$/);
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

  const staticSnapshot = (content: string, shared = "export const site = {};", contract = "", manifest = "") => {
    mocks.query.mockImplementation(async (ref) => getFunctionName(ref) === "files:getBuildFiles" ? [
      { _id: "manifest", name: "package.json", type: "file", content: manifest },
      { _id: "layout", name: "src/app/layout.tsx", type: "file", content: "export default () => null;" },
      { _id: "src", name: "src", type: "folder" },
      { _id: "pages", name: "pages", type: "folder", parentId: "src" },
      { _id: "home", name: "home.tsx", type: "file", parentId: "pages", content },
      { _id: "data", name: "data.ts", type: "file", parentId: "pages", content: shared },
      { _id: "types", name: "types.ts", type: "file", parentId: "src", content: contract },
      // An unrelated broken file must not send this worker back to repair it.
      { _id: "other", name: "other.ts", type: "file", parentId: "src", content: 'import "./missing";' },
    ] : getFunctionName(ref) === "system:getProjectById" ? { ownerId: "user_1" } :
      getFunctionName(ref) === "system:getProjectFiles" ? [] : null);
  };

  it.each([true, false])("prompts once for a missing import and finishes even if still broken (repaired: %s)", async (repaired) => {
    const broken = 'import Missing from "@/components/Missing"; export default Missing;';
    staticSnapshot(broken);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content: broken }] }) },
      { data: text("Built it.") },
      ...(repaired ? [{ data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content: "export default () => null;" }] }) }] : []),
      { data: text(repaired ? "Fixed the import." : "NEEDS: missing shared component.") },
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.data).toMatchObject({ status: "done", summary: repaired ? "Fixed the import." : "NEEDS: missing shared component." });
    expect(outcome.inferenceBodies).toHaveLength(repaired ? 4 : 3);
    const requests = outcome.inferenceBodies as Array<{ messages: Array<{ role: string; content: unknown }> }>;
    const fix = requests[2].messages.at(-1);
    expect(fix).toEqual({ role: "user", content: expect.stringContaining("Fix these before finishing") });
    expect(fix?.content).toContain("@/components/Missing (imported by src/pages/home.tsx)");
    expect(fix?.content).not.toContain("other.ts");
    expect(fix?.content).toContain("Read the shared contract files you use");
    expect(fix?.content).toContain("Give the FULL final summary again, including any NEEDS: lines");
    expect(requests.filter((request) => String(request.messages.at(-1)?.content).startsWith("Fix these before finishing"))).toHaveLength(1);
  });

  it.each([false, true])("preserves the first NEEDS block unless the repair summary supplies one (repeated: %s)", async (repeated) => {
    const content = 'import Missing from "./missing"; export default Missing;';
    const needs = "NEEDS: add react-router-dom\n- Wire /home in src/App.tsx";
    staticSnapshot(content);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text(`Built it.\n${needs}`) },
      { data: text(`Fixed it.${repeated ? `\n${needs}` : ""}`) },
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.data).toMatchObject({ summary: `Fixed it.\n${needs}` });
    expect(mutationArgs("agentTasks:finishTask").at(-1)).toMatchObject({ summary: `Fixed it.\n${needs}` });
    expect(outcome.inferenceBodies).toHaveLength(3);
  });

  it.each(["next", "vite"])("uses projectChecks' framework detection for %s", async (framework) => {
    const content = 'import Missing from "./missing"; import { MissingExport } from "./data"; export default Missing;';
    staticSnapshot(content, "export const present = {};", "", JSON.stringify({ dependencies: { [framework]: "1.0.0" } }));
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
      ...(framework === "vite" ? [{ data: text("NEEDS: missing import.") }] : []),
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(framework === "next" ? 2 : 3);
  });

  it("finishes clean imports without another turn", async () => {
    const content = 'import { site as data } from "./data"; export default () => data;';
    staticSnapshot(content);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(2);
  });

  it.each([
    ['import { missing as data } from "./data";', "no such export"],
    ['import data from "./data";', "no default export"],
  ])("checks shared exports: %s", async (imports, diagnostic) => {
    const content = `${imports} export default () => data;`;
    staticSnapshot(content);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
      { data: text("NEEDS: shared data export.") },
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(3);
    const requests = outcome.inferenceBodies as Array<{ messages: Array<{ content: unknown }> }>;
    expect(requests[2].messages.at(-1)?.content).toContain(diagnostic);
  });

  it.each([
    { target: "@/components/nav", retry: false },
    { target: "./missing", retry: true },
    { target: "../../public/missing.png", retry: true },
    { target: "@/unowned/missing", retry: true },
    { target: "@/types/missing", retry: false },
    { target: "@/data/missing", retry: false },
    { target: "@/components/shared/missing", retry: false },
    { target: "@/App", retry: false },
  ])("defers sibling/foundation imports but checks own/unowned: $target", async ({ target, retry }) => {
    const content = `import Missing from "${target}"; export default Missing;`;
    staticSnapshot(content);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
      ...(retry ? [{ data: text("NEEDS: missing import.") }] : []),
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(retry ? 3 : 2);
  });

  it.each(["", "// fully written sibling\n".repeat(20)])("defers sibling exports even when already on disk (%s)", async (stub) => {
    const content = 'import { Missing } from "./data"; export default Missing;';
    staticSnapshot(content, stub);
    mocks.mutation.mockImplementation(async (ref, args) => getFunctionName(ref) === "agentTasks:startTask"
      ? { ...TASK, ownedPaths: ["src/pages/home.tsx"] } : MUTATIONS[getFunctionName(ref)]?.(args) ?? null);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
    ], { siblingOwnedPaths: ["src/pages/data.ts"] });
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(2);
  });

  it.each([false, true])("checks shared exports only past the placeholder threshold (complete: %s)", async (complete) => {
    const content = 'import { Missing } from "../types"; export default Missing;';
    staticSnapshot(content, "", "export const present = {};" + (complete ? "// implemented\n".repeat(20) : ""));
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
      ...(complete ? [{ data: text("NEEDS: shared type export.") }] : []),
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(complete ? 3 : 2);
  });

  it.each([undefined, 2])("defers outside missing imports without a complete top-level plan (depth: %s)", async (depth) => {
    const content = 'import Missing from "@/unknown/Missing"; export default Missing;';
    staticSnapshot(content);
    const outcome = await run([
      { data: toolCall("writeFiles", { files: [{ path: "src/pages/home.tsx", content }] }) },
      { data: text("Built it.") },
    ], depth === undefined ? { siblingOwnedPaths: undefined } : { depth });
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(2);
  });

  it("skips the static snapshot when nothing was written", async () => {
    const outcome = await run([{ data: text("No changes needed.") }]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(1);
    expect(mocks.query.mock.calls.some(([ref]) => getFunctionName(ref) === "files:getBuildFiles")).toBe(false);
  });

  it("puts the user's original request in the system prompt, and none when absent", async () => {
    const withPrompt = await run([{ data: text("Built it.") }], { originalPrompt: "Pizzeria on 5 Main St, margherita 9.50" });
    const [request] = withPrompt.inferenceBodies as Array<{ messages: Array<{ content: unknown }> }>;
    expect((request.messages[0].content as SystemBlock[])[0].text).toContain("original request (context, build only your task)\nPizzeria on 5 Main St, margherita 9.50");

    const without = await run([{ data: text("Built it.") }]);
    const [bare] = without.inferenceBodies as Array<{ messages: Array<{ content: unknown }> }>;
    expect((bare.messages[0].content as SystemBlock[])[0].text).not.toContain("original request");
  });

  it("stores its report without a suggestions block (#256)", async () => {
    const outcome = await run([
      { data: text("Built the home page.\n\n<suggestions>\nAdd a footer\n</suggestions>") },
    ]);

    expect(outcome.data).toMatchObject({ status: "done", summary: "Built the home page." });
    expect(mutationArgs("agentTasks:finishTask")).toEqual([
      expect.objectContaining({ status: "done", summary: "Built the home page." }),
    ]);
    const [request] = outcome.inferenceBodies as Array<{ messages: Array<{ content: unknown }> }>;
    // Its reply goes to the orchestrator: the NEEDS: report, not the user voice or chips.
    const [shared] = request.messages[0].content as SystemBlock[];
    expect(shared.text).toContain("in a NEEDS: section for the orchestrator");
    expect(shared.text).toContain(
      "Your reply goes to the orchestrator, not the user: no next steps, suggestions or action chips.",
    );
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

  it("is cancelled with its parent message or on its own timeout, with per-owner concurrency at the plan limit", () => {
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
    expect(opts.concurrency).toEqual([{ key: "event.data.ownerId", limit: 5 }]);
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
  // Over the cap: the oldest text goes, the newest request (the tail) stays.
  const LONG_REQUEST = `${"old ".repeat(MAX_ORIGINAL_PROMPT_CHARS)}NEWEST REQUEST`;
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
    ], { originalPrompt: LONG_REQUEST }, [CART, LIST]);

    expect(outcome.finalType).toBe("function-resolved");
    const [request] = outcome.inferenceBodies as Array<{ messages: Array<{ content: unknown }>; tools: Array<{ function: { name: string } }> }>;
    expect(request.tools.map((tool) => tool.function.name)).toContain("delegateTasks");
    const [shared] = request.messages[0].content as SystemBlock[];
    expect(shared).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(shared.text).toContain("[swarm-worker]");
    expect(shared.text).toContain("[swarm-suborchestrator]");

    expect(mutationArgs("agentTasks:createTasks")).toEqual([expect.objectContaining({
      messageId: "m1",
      tasks: [
        expect.objectContaining({ taskId: "shop/cart", parentTaskId: "shop", role: "worker", modelId: "anthropic/claude-haiku-5.5" }),
        expect.objectContaining({ taskId: "shop/list", parentTaskId: "shop", role: "worker" }),
      ],
    })]);
    // Children carry both parent ids, so message and sub-orchestrator cancellation reach them.
    const [{ payload }] = outcome.invocations as Array<{ payload: { data: { originalPrompt: string } } }>;
    expect(payload.data.originalPrompt).toHaveLength(MAX_ORIGINAL_PROMPT_CHARS);
    expect(payload.data.originalPrompt).toMatch(/^\[truncated\] .*NEWEST REQUEST$/);
    expect(outcome.invocations).toEqual([
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "child_0", parentAgentTaskId: "t1", parentMessageId: "m1", ownerId: "user_1", depth: 2, originalPrompt: capOriginalPrompt(LONG_REQUEST) }) }, timeout: "9m" }),
      expect.objectContaining({ payload: { data: expect.objectContaining({ agentTaskId: "child_1", parentAgentTaskId: "t1", depth: 2 }) }, timeout: "9m" }),
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

    const [request] = outcome.inferenceBodies as Array<{ messages: Array<{ content: unknown }>; tools: Array<{ function: { name: string } }> }>;
    expect(request.tools.map((tool) => tool.function.name)).not.toContain("delegateTasks");
    const [shared] = request.messages[0].content as SystemBlock[];
    expect(shared.text).toContain("[swarm-worker]");
    expect(shared.text).not.toContain("[swarm-suborchestrator]");
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
