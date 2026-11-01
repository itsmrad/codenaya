/**
 * The run's step budget (#290): parallel tool calls are requested, several
 * calls in one turn are all recorded, and a run that never stops calling tools
 * gets a last no-tools note and ends with an honest reply.
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

import { drive, text } from "./process-message.driver";
import { MAX_AGENT_ITERATIONS, STEP_BUDGET_REPLY } from "./process-message";

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectFilesWithUrls": () => [],
  "system:getProjectSkills": () => [],
};

const toolCalls = (...ids: string[]) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: ids.map((id) => ({
          id,
          type: "function",
          function: { name: "listFiles", arguments: "{}" },
        })),
      },
      finish_reason: "tool_calls",
    },
  ],
});

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  parallel_tool_calls?: boolean;
}

const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);

const finalReply = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "system:updateMessageContent")
    .map(([, args]) => (args as { content: string }).content)
    .at(-1);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage step budget", () => {
  it("asks for parallel tool calls and records every call in a turn", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: toolCalls("call_a", "call_b", "call_c") },
      { data: text("Listed.") },
    ]);

    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.parallel_tool_calls).toBe(true);

    const toolSteps = mocks.mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === "system:upsertMessageSteps")
      .flatMap(([, args]) => (args as { steps: Array<{ id: string; kind: string }> }).steps)
      .filter((step) => step.kind === "tool");
    expect(new Set(toolSteps.map((step) => step.id))).toEqual(new Set(["call_a", "call_b", "call_c"]));
    expect(finalReply()).toBe("Listed.");
  });

  it("sends a last no-tools note and ends honestly when the agent never stops", async () => {
    // The driver repeats the last inference: a model that always calls a tool.
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [{ data: toolCalls("call_loop") }]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(MAX_AGENT_ITERATIONS);
    expect(JSON.stringify(requests.at(-1)?.messages.at(-1))).toContain("Step budget reached");
    expect(JSON.stringify(requests.at(-2)?.messages)).not.toContain("Step budget reached");
    expect(finalReply()).toBe(STEP_BUDGET_REPLY);
    // The driver replays the whole run for every step, so 40 turns are slow.
  }, 60_000);
});
