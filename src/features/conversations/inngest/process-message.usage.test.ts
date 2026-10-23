/**
 * Platform usage metering of the real `processMessage` function under
 * Inngest's execution engine, replayed the way the platform does it. Convex is
 * the only fake. Proves each model call is recorded once however often the
 * run replays, that a cap stops the run, and that BYOK runs are never metered.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UNDER_CAP } from "@/features/ai-providers/server/active-platform.mock";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  openProviderKey: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/features/ai-providers/server/sealed-key", () => ({
  openProviderKey: mocks.openProviderKey,
}));
vi.mock("@/features/ai-providers/server/test-connection", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  testConnection: mocks.testConnection,
}));

import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { drive, text } from "./process-message.driver";

const OVER_CAP = { ...UNDER_CAP, costMicroUsd: 3_000_000, exceeded: true, exceededBy: "usd" };

/** A response that carries the provider's token usage. */
const withUsage = (body: object, prompt: number, completion: number) => ({
  ...body,
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

const listFiles = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "listFiles", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    },
  ],
};

let checkLimit: unknown;
let recordAnswers: unknown[];

const QUERIES: Record<string, (args: unknown) => unknown> = {
  "platformModels:getActiveForServer": () => ({ provider: "openrouter", config: null }),
  "aiUsage:checkLimit": () => checkLimit,
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => [],
  "system:getAiProviderKeyForRun": () => ({
    _id: "key_1",
    userId: "user_1",
    provider: "openai",
    label: "Work key",
    status: "active",
  }),
};

const calls = (mock: typeof mocks.query, name: string) =>
  mock.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const replyContent = () =>
  (calls(mocks.mutation, "system:updateMessageContent").at(-1) as { content: string } | undefined)?.content;

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  checkLimit = UNDER_CAP;
  recordAnswers = [];
  mocks.query.mockImplementation(async (ref, args) => QUERIES[getFunctionName(ref)]?.(args));
  mocks.mutation.mockImplementation(async (ref) =>
    getFunctionName(ref) === "aiUsage:record" ? (recordAnswers.shift() ?? UNDER_CAP) : null,
  );
  mocks.openProviderKey.mockResolvedValue("sk-user-secret");
  mocks.testConnection.mockResolvedValue({ ok: true });
});

describe("processMessage usage metering", () => {
  it("records every platform call exactly once, to the owner, however often the run replays", async () => {
    const outcome = await drive({ modelId: "" }, [
      { data: withUsage(text("Listing files"), 40, 5) },
      { data: withUsage(listFiles, 1_200, 30) },
      { data: withUsage(text("Here are your files."), 1_500, 60) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const records = calls(mocks.mutation, "aiUsage:record");
    expect(records).toEqual([
      expect.objectContaining({ key: "run-under-test:title", source: "title", userId: "user_1", inputTokens: 40, outputTokens: 5 }),
      expect.objectContaining({ key: "run-under-test:t0", source: "agent", provider: "openrouter", inputTokens: 1_200, outputTokens: 30 }),
      expect.objectContaining({ key: "run-under-test:t1", source: "agent", inputTokens: 1_500, outputTokens: 60 }),
    ]);
    expect(calls(mocks.query, "aiUsage:checkLimit")).toEqual([
      { internalKey: "ik", userId: "user_1", month: expect.stringMatching(/^\d{4}-\d{2}$/) },
    ]);
    expect(replyContent()).toBe("Here are your files.");
  });

  it("refuses to start over the cap, without any model call", async () => {
    checkLimit = OVER_CAP;

    const outcome = await drive({ modelId: "" }, [{ data: text("never") }]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceUrls).toEqual([]);
    expect(calls(mocks.mutation, "aiUsage:record")).toEqual([]);
    expect(replyContent()).toMatch(/Free plan's \$3\.00 of Codenaya AI/);
  });

  it("stops before the next model call once a call reaches the cap", async () => {
    // Title under the cap, the first coding turn reaches it.
    recordAnswers = [UNDER_CAP, OVER_CAP];

    const outcome = await drive({ modelId: "" }, [
      { data: withUsage(text("Listing files"), 40, 5) },
      { data: withUsage(listFiles, 1_200, 30) },
      { data: withUsage(text("not reached"), 1, 1) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceUrls).toHaveLength(2);
    expect(calls(mocks.mutation, "aiUsage:record")).toHaveLength(2);
    expect(replyContent()).toMatch(/Stopped: monthly AI limit reached\.\*\* You've used your Free plan's \$3\.00/);
  });

  it("never meters or checks a run on the user's own key", async () => {
    checkLimit = OVER_CAP;

    const outcome = await drive({ keyId: "key_1", modelId: "gpt-6.1-sol" }, [
      { data: withUsage(text("Listing files"), 40, 5) },
      { data: withUsage(text("Here are your files."), 1_500, 60) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(calls(mocks.query, "aiUsage:checkLimit")).toEqual([]);
    expect(calls(mocks.mutation, "aiUsage:record")).toEqual([]);
    expect(replyContent()).toBe("Here are your files.");
  });
});
