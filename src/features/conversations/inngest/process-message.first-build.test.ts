/**
 * The first-build critical path (#338) in a real `processMessage` run: the
 * title runs alongside the coding agent and is settled on every way out, a
 * starter-only project says so in the request, and only a run that wrote
 * files ends a seeded project's first build.
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
import { STARTER_IN_PLACE_NOTE } from "./constants";
import { drive, text, toolCall } from "./process-message.driver";
import { VITE_REACT_STARTER } from "./vite-starter";

let projectFiles: unknown[];

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => projectFiles,
  "system:getProjectSkills": () => [],
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
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
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === "system:createFiles"
      ? (args as { files: Array<{ name: string }> }).files.map(({ name }) => ({ name, fileId: "f1" }))
      : null,
  );
  projectFiles = [];
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
  it("ends a seeded project's first build when the run wrote files", async () => {
    await drive(MODEL, [{ data: text("Todo app") }, { data: WRITE }, { data: text("Built it.") }]);

    expect(called("projects:completeFirstBuild")).toEqual([
      ["projects:completeFirstBuild", { internalKey: "ik", projectId: "p1" }],
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
