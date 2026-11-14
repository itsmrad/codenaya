/**
 * A reply cut off at the output limit (#493) in a real `processMessage` run:
 * its broken tool call doesn't run or fail the run, the model is told to write
 * less per turn, and every turn start refreshes the run's stall clock.
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

import { TURN_HEARTBEAT_ID } from "../agent-steps";
import { OUTPUT_LIMIT_ERROR, OUTPUT_LIMIT_NOTE } from "./lib/output-limit";
import { drive, text } from "./process-message.driver";

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectFilesWithUrls": () => [],
  "system:getProjectSkills": () => [],
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ function: { arguments: string } }> }>;
  tools?: unknown[];
}

const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>);

const recordedSteps = () =>
  mutationArgs("system:upsertMessageSteps").flatMap(
    ({ steps }) => steps as Array<{ id: string; status: string; error?: string; endedAt?: number }>,
  );

/** An OpenAI-style reply stopped by the output limit. */
const cutOff = (message: Record<string, unknown>) => ({
  data: { choices: [{ message: { role: "assistant", ...message }, finish_reason: "length" }] },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage when a reply hits the output limit", () => {
  it("refuses the cut-off writeFiles call and tells the model to write less", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      cutOff({
        content: null,
        tool_calls: [
          {
            id: "call_write",
            type: "function",
            // Cut off mid-string: AgentKit's parser would throw on it.
            function: { name: "writeFiles", arguments: '{"files":[{"path":"src/App.tsx","content":"export def' },
          },
        ],
      }),
      { data: text("Wrote the app in smaller pieces.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    // Nothing was written.
    expect(mutationArgs("system:createFiles")).toEqual([]);
    expect(mutationArgs("system:updateFile")).toEqual([]);

    const [, next] = codingRequests(outcome.inferenceBodies);
    const assistant = next.messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(assistant?.tool_calls?.[0].function.arguments).toBe("{}");
    expect(next.messages.find((m) => m.role === "tool")?.content).toContain(OUTPUT_LIMIT_ERROR.slice(7));

    const write = recordedSteps().filter((step) => step.id === "call_write").at(-1);
    expect(write).toMatchObject({ status: "error", error: expect.stringContaining("output limit") });
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({
      content: "Wrote the app in smaller pieces.",
    });
  });

  it("nudges the next turn when the reply was cut off before any tool call", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      cutOff({ content: "" }),
      { data: text("Done.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({ role: "user", content: OUTPUT_LIMIT_NOTE });
    expect(JSON.stringify(requests[0])).not.toContain(OUTPUT_LIMIT_NOTE);
  });

  it("records one heartbeat step per turn start, under one id", async () => {
    await drive({ modelId: "x-ai/grok-4.7" }, [cutOff({ content: "" }), { data: text("Done.") }]);

    const beats = recordedSteps().filter((step) => step.id === TURN_HEARTBEAT_ID);
    expect(beats).toHaveLength(2);
    expect(beats.every((beat) => beat.status === "done" && typeof beat.endedAt === "number")).toBe(true);
  });
});
