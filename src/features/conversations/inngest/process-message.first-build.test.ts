/**
 * The first-build critical path (#338) in a real `processMessage` run: the
 * title runs alongside the coding agent and is settled on every way out, a
 * starter-only project says so in the request, and only a run that wrote
 * files and verified its build ends a seeded project's first build (the
 * verified case is in process-message.check-build.test.ts).
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query), mutation: mocks.mutation } };
});

import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { BUILD_NOT_BUILT_NOTE, BUILD_UNVERIFIED_NOTE } from "./build-check-gate";
import { FIRST_BUILD_APP_NOTE, NEXT_FIRST_BUILD_APP_NOTE, NEXT_STARTER_IN_PLACE_NOTE, NEXT_STARTER_RECOVERY_NOTE, START_FIRST_BUILD_APP_NOTE, START_STARTER_IN_PLACE_NOTE, START_STARTER_RECOVERY_NOTE, STARTER_IN_PLACE_NOTE } from "./constants";
import { NEXT_APP_STARTER } from "./next-starter";
import { TANSTACK_START_STARTER } from "./tanstack-start-starter";
import { drive, text, toolCall } from "./process-message.driver";
import { VITE_REACT_STARTER } from "./vite-starter";

let projectFiles: unknown[];
let needsFirstBuild: boolean;
let recentMessages: Array<{ _id: string; role: "user" | "assistant"; content: string }>;

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => recentMessages,
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => projectFiles,
  "files:getBuildFiles": () => projectFiles,
  "system:getProjectSkills": () => [],
  "projects:conversationNeedsFirstBuildForServer": () => needsFirstBuild,
  "swarm:getSwarmSettings": () => ({ enabled: true, platformMaxDepth: 1 }),
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

const codingRequest = (bodies: unknown[]) => {
  const { messages } = (bodies as ChatBody[]).find((body) => body.tools)!;
  return {
    system: JSON.stringify(messages.find((m) => m.role === "system")),
    user: JSON.stringify(messages.filter((m) => m.role === "user").at(-1)),
  };
};
const mutations = () =>
  mocks.mutation.mock.calls.map(([ref, args]) => [getFunctionName(ref), args]);
const called = (name: string) => mutations().filter(([n]) => n === name);

const FAILED = { error: { name: "Error", message: "AI request failed with status 500" } };
const WRITE = toolCall("createFiles", { parentId: "", files: [{ name: "App.tsx", content: "x" }] });
const MODEL = { modelId: "x-ai/grok-4.7" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  // No sandbox: checkBuild runs its static checks only.
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === "system:createFiles"
      ? (args as { files: Array<{ name: string }> }).files.map(({ name }) => ({ name, fileId: "f1" }))
      : null,
  );
  projectFiles = [];
  recentMessages = [];
  needsFirstBuild = false;
});

describe("processMessage title off the first-build path", () => {
  it("requests the coding turn before the title resolves; a later title is still saved", async () => {
    const outcome = await drive(MODEL, [
      { data: text("Todo app"), held: true },
      { data: text("Built it.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceRequests[1]).toBeLessThan(outcome.inferenceResolvedAt[0]!);
    expect(called("system:updateConversationTitle")).toEqual([
      ["system:updateConversationTitle", expect.objectContaining({ title: "Todo app" })],
    ]);
    expect(called("system:updateMessageContent")).toEqual([
      ["system:updateMessageContent", expect.objectContaining({ content: "Built it." })],
    ]);
  });

  it("finishes with the default title when the title fails after the coding run", async () => {
    const outcome = await drive(MODEL, [{ ...FAILED, held: true }, { data: text("Built it.") }]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(called("system:updateConversationTitle")).toEqual([]);
    expect(called("system:updateMessageContent")).toHaveLength(1);
    // The coding record, then the one final flush.
    expect(called("credits:recordRunUsage")).toHaveLength(2);
  });

  it("waits for the title and flushes usage once when the coding run fails", async () => {
    const outcome = await drive(MODEL, [{ data: text("Todo app"), held: true }, FAILED]);

    expect(outcome.finalType).not.toBe("function-resolved");
    expect(called("system:updateConversationTitle")).toHaveLength(1);
    // The title's record, then the error path's flush.
    expect(called("credits:recordRunUsage")).toHaveLength(2);
    expect(called("projects:completeFirstBuild")).toEqual([]);
  });

  it("stops cleanly when cancelled while the title is pending", async () => {
    const outcome = await drive(
      MODEL,
      [{ data: text("Todo app"), held: true }, { data: text("Built it.") }],
      undefined,
      {},
      { cancelWhen: () => called("credits:recordRunUsage").length > 0 },
    );

    expect(outcome.finalType).toBe("cancelled");
    // The coding turn's own record is the cancelled run's usage.
    expect(called("credits:recordRunUsage")).toHaveLength(1);
    expect(called("system:updateConversationTitle")).toEqual([]);
    expect(called("system:updateMessageContent")).toEqual([]);
  });
});

describe("processMessage first build (#338)", () => {
  it.each(["Build a Next.js todo app", "Build a todo app"])("keeps a modified Next app on its framework without recovery guidance (original prompt: %s)", async (originalPrompt) => {
    projectFiles = [
      { _id: "pkg", name: "package.json", type: "file" },
      { _id: "config", name: "next.config.ts", type: "file" },
      { _id: "src", name: "src", type: "folder" },
      { _id: "app", name: "app", type: "folder", parentId: "src" },
      { _id: "page", name: "page.tsx", type: "file", parentId: "app" },
      { _id: "search", name: "search.tsx", type: "file", parentId: "app" },
    ];
    recentMessages = [
      { _id: "u1", role: "user", content: originalPrompt },
      { _id: "a1", role: "assistant", content: "Built it." },
      { _id: "u2", role: "user", content: "Add search" },
      { _id: "m1", role: "assistant", content: "" },
    ];
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "Add search");
    const { system, user } = codingRequest(outcome.inferenceBodies);
    for (const note of [NEXT_STARTER_RECOVERY_NOTE, NEXT_STARTER_IN_PLACE_NOTE, STARTER_IN_PLACE_NOTE]) {
      expect(user).not.toContain(JSON.stringify(note).slice(1, -1));
    }
    expect(system).not.toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
  });

  it("keeps Vite starter guidance and tools even when the original prompt named Next", async () => {
    needsFirstBuild = true;
    projectFiles = VITE_REACT_STARTER.map(({ path }) => ({ _id: `id:${path}`, name: path, type: "file" }));
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "Build a Next.js todo app");
    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(system).toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(user).toContain(JSON.stringify(STARTER_IN_PLACE_NOTE).slice(1, -1));
    expect(user).not.toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).toContain("scaffoldViteApp");
  });

  it.each(["empty", "partial"])("keeps an explicit Next request on Next when the seed is %s", async (kind) => {
    needsFirstBuild = true;
    projectFiles = kind === "partial"
      ? [{ _id: "layout", name: "src/app/layout.tsx", type: "file" }]
      : [];
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "Build a Next JS todo app");
    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(system).toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    expect(system).not.toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(user).toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    expect(user).not.toContain(JSON.stringify(NEXT_STARTER_IN_PLACE_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
    expect(coding.tools?.map((tool) => tool.function.name)).toContain("writeFiles");
  });

  it("preserves the original Next request when retrying a failed seed with continue", async () => {
    needsFirstBuild = true;
    recentMessages = [
      { _id: "u1", role: "user", content: "Build a Next.js todo app" },
      { _id: "a1", role: "assistant", content: "" },
      { _id: "u2", role: "user", content: "Continue" },
      { _id: "m1", role: "assistant", content: "" },
    ];
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "Continue");
    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(system).toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    expect(system).not.toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(user).toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
  });

  it("uses Start first-build guidance and does not offer the Vite scaffold for a Start starter", async () => {
    needsFirstBuild = true;
    projectFiles = TANSTACK_START_STARTER.map(({ path }) => ({ _id: `id:${path}`, name: path, type: "file" }));
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }]);
    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(system).toContain(JSON.stringify(START_FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(system).not.toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(user).toContain(JSON.stringify(START_STARTER_IN_PLACE_NOTE).slice(1, -1));
    expect(user).not.toContain(JSON.stringify(STARTER_IN_PLACE_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
  });

  it("keeps an explicit Start request on Start when the seed is empty", async () => {
    needsFirstBuild = true;
    projectFiles = [];
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "Build a TanStack Start todo app");
    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(system).toContain(JSON.stringify(START_STARTER_RECOVERY_NOTE).slice(1, -1));
    expect(user).toContain(JSON.stringify(START_STARTER_RECOVERY_NOTE).slice(1, -1));
    expect(user).not.toContain(JSON.stringify(NEXT_STARTER_RECOVERY_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
  });

  it.each([
    ["a Vite starter", VITE_REACT_STARTER.map(({ path }) => path), "Build a todo app", false],
    ["a Next starter", NEXT_APP_STARTER.map(({ path }) => path), "Build a todo app", false],
    ["a TanStack Start project", ["package.json", "vite.config.ts", "src/router.tsx", "src/routes/__root.tsx"], "Add a blog", true],
    ["an empty project asked for TanStack Start", [], "Build a TanStack Start blog", true],
  ])("adds the TanStack Start rules only for a Start run: %s", async (_, paths, prompt, start) => {
    projectFiles = paths.map((path) => ({ _id: `id:${path}`, name: path, type: "file" }));
    const outcome = await drive(MODEL, [{ data: text("Blog") }, { data: text("Built it.") }], prompt);
    expect(codingRequest(outcome.inferenceBodies).system.includes("<tanstack_start>")).toBe(start);
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    if (start) expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
  });

  it("uses Next first-build guidance and does not offer the Vite scaffold for a Next starter", async () => {
    needsFirstBuild = true;
    projectFiles = NEXT_APP_STARTER.map(({ path }) => ({ _id: `id:${path}`, name: path, type: "file" }));
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }]);
    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(system).toContain(JSON.stringify(NEXT_FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(system).not.toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(user).toContain(JSON.stringify(NEXT_STARTER_IN_PLACE_NOTE).slice(1, -1));
    expect(user).not.toContain(JSON.stringify(STARTER_IN_PLACE_NOTE).slice(1, -1));
    const coding = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools)!;
    expect(coding.tools?.map((tool) => tool.function.name)).not.toContain("scaffoldViteApp");
    expect(coding.tools?.map((tool) => tool.function.name)).toContain("writeFiles");
  });

  it.each(["seeded", "empty"])("adds early App guidance for a %s solo first build", async (kind) => {
    needsFirstBuild = true;
    projectFiles = kind === "seeded"
      ? VITE_REACT_STARTER.map(({ path }) => ({ _id: `id:${path}`, name: path, type: "file" }))
      : [];

    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }]);

    expect(codingRequest(outcome.inferenceBodies).system)
      .toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
    expect(mocks.query.mock.calls.map(([ref, args]) => [getFunctionName(ref), args])).toContainEqual([
      "projects:conversationNeedsFirstBuildForServer",
      { internalKey: "ik", conversationId: "c1" },
    ]);
  });

  it.each([
    ["a follow-up", false, undefined],
    ["a plan", true, "plan"],
    ["a top-level swarm", true, "swarm"],
  ] as const)("does not add solo early App guidance for %s", async (_, firstBuild, mode) => {
    needsFirstBuild = firstBuild;
    const outcome = await drive(
      MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "todo app", { mode },
    );

    expect(codingRequest(outcome.inferenceBodies).system)
      .not.toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
  });

  it("adds early App guidance when swarm was requested but the kill switch is off", async () => {
    needsFirstBuild = true;
    mocks.query.mockImplementation(async (ref) => {
      const name = getFunctionName(ref);
      if (name === "swarm:getSwarmSettings") return { enabled: false, platformMaxDepth: 1 };
      return QUERIES[name]?.();
    });

    const outcome = await drive(
      MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }], "todo app", { mode: "swarm" },
    );

    expect(codingRequest(outcome.inferenceBodies).system)
      .toContain(JSON.stringify(FIRST_BUILD_APP_NOTE).slice(1, -1));
  });

  it("leaves the first build pending when the check could not build the app", async () => {
    // No sandbox and no Vite project: the check passes without building.
    await drive(MODEL, [
      { data: text("Todo app") },
      { data: WRITE },
      { data: toolCall("checkBuild") },
      { data: text("Built it.") },
    ]);

    expect(called("projects:completeFirstBuild")).toEqual([]);
    expect(called("system:updateMessageContent")).toEqual([
      [
        "system:updateMessageContent",
        expect.objectContaining({ content: `Built it.\n\n${BUILD_NOT_BUILT_NOTE}`, outcome: "error" }),
      ],
    ]);
  });

  it("leaves the first build pending when the run's changes were never checked", async () => {
    // The driver repeats the last reply, so every forced turn ends without a check.
    await drive(MODEL, [{ data: text("Todo app") }, { data: WRITE }, { data: text("Built it.") }]);

    expect(called("projects:completeFirstBuild")).toEqual([]);
    expect(called("system:updateMessageContent")).toEqual([
      [
        "system:updateMessageContent",
        expect.objectContaining({ content: `Built it.\n\n${BUILD_UNVERIFIED_NOTE}`, outcome: "error" }),
      ],
    ]);
  });

  it.each([
    ["a reply that wrote nothing", {}],
    ["a plan", { mode: "plan" }],
  ])("leaves the first build pending after %s", async (_, extra) => {
    await drive(MODEL, [{ data: text("Todo app") }, { data: text("Here's how.") }], "todo app", extra);

    expect(called("projects:completeFirstBuild")).toEqual([]);
  });

  it("tells a starter-only project's first turn the starter is in place, outside the system prompt", async () => {
    projectFiles = VITE_REACT_STARTER.map(({ path }) => ({
      _id: `id:${path}`,
      name: path,
      type: "file",
    }));

    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }]);

    const { system, user } = codingRequest(outcome.inferenceBodies);
    expect(user).toContain(JSON.stringify(STARTER_IN_PLACE_NOTE).slice(1, -1));
    expect(system).not.toContain(JSON.stringify(STARTER_IN_PLACE_NOTE).slice(1, -1));
    expect(system).not.toContain("id:package.json");
  });

  it("leaves any other project's request as sent", async () => {
    const outcome = await drive(MODEL, [{ data: text("Todo app") }, { data: text("Built it.") }]);

    expect(codingRequest(outcome.inferenceBodies).user).not.toContain("Vite starter");
  });
});
