/**
 * Parallel tool calls and the step budget in a real `processMessage` run: a
 * turn's several calls all reach the run block, and a run that never stops
 * calling tools ends with a summary from a final turn with tools off.
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

// A small budget keeps the replayed run fast; the routing is the same at 40.
vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MAX_AGENT_STEPS: 4,
}));

import { BUILD_CHECK_NUDGE } from "./build-check-gate";
import { MAX_AGENT_STEPS, STEP_BUDGET_NOTE } from "./constants";
import { drive, text, toolCall } from "./process-message.driver";

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
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
}

const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);

const recordedSteps = () =>
  mutationArgs("system:upsertMessageSteps").flatMap(
    ({ steps }) => steps as Array<{ id: string; kind: string; tool?: string; status: string }>,
  );

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>);

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  // No sandbox: checkBuild runs its static checks only.
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage parallel tool calls", () => {
  it("asks for parallel calls and records every call of a turn as a step", async () => {
    const calls = ["a", "b", "c"].map((name) => ({
      id: `call_${name}`,
      type: "function",
      function: { name: "listFiles", arguments: "{}" },
    }));
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      {
        data: {
          choices: [
            { message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" },
          ],
        },
      },
      { data: text("Here are your files.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(codingRequests(outcome.inferenceBodies)[0]).toMatchObject({ parallel_tool_calls: true });

    const finished = recordedSteps().filter((step) => step.kind === "tool" && step.status === "done");
    expect(finished.map((step) => step.id)).toEqual(["call_a", "call_b", "call_c"]);
  });
});

describe("processMessage step budget", () => {
  it("ends a run that never stops calling tools with a summary from a no-tools turn", async () => {
    const summary = "**What was built:** part of a todo app.\n\n**Notes:** The list view is not done yet.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      ...Array.from({ length: MAX_AGENT_STEPS - 1 }, () => ({ data: toolCall("listFiles") })),
      { data: text(summary) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(MAX_AGENT_STEPS);

    const last = requests.at(-1);
    expect(last?.tool_choice).toBe("none");
    expect(last?.messages.at(-1)).toEqual({ role: "user", content: STEP_BUDGET_NOTE });
    expect(requests.slice(0, -1).every((request) => request.tool_choice === "auto")).toBe(true);
    expect(JSON.stringify(requests.slice(0, -1))).not.toContain(STEP_BUDGET_NOTE);

    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({ content: summary });
  });

  it("keeps a summary given on the last step instead of routing back for checkBuild", async () => {
    const summary = "**What was built:** a cleanup.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      ...Array.from({ length: MAX_AGENT_STEPS - 2 }, () => ({
        data: toolCall("deleteFiles", { fileIds: ["f1"] }),
      })),
      { data: text(summary) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(codingRequests(outcome.inferenceBodies)).toHaveLength(MAX_AGENT_STEPS - 1);
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({ content: summary });
  });

  it("drops tool calls a provider makes on the last step anyway, and keeps its text", async () => {
    const summary = "**What was built:** part of a todo app.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      ...Array.from({ length: MAX_AGENT_STEPS - 1 }, () => ({ data: toolCall("listFiles") })),
      {
        data: {
          choices: [
            {
              message: {
                role: "assistant",
                content: summary,
                tool_calls: [
                  { id: "call_late", type: "function", function: { name: "deleteFiles", arguments: '{"fileIds":["f1"]}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(codingRequests(outcome.inferenceBodies)).toHaveLength(MAX_AGENT_STEPS);
    expect(recordedSteps().some((step) => step.tool === "deleteFiles")).toBe(false);
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({ content: summary });
  });

  it("runs the build-check turn, then the summary turn with only the budget note", async () => {
    const summary = "**What was built:** a cleanup, build checked.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      ...Array.from({ length: MAX_AGENT_STEPS - 3 }, () => ({
        data: toolCall("deleteFiles", { fileIds: ["f1"] }),
      })),
      { data: text("**What was built:** a cleanup.") },
      { data: toolCall("checkBuild") },
      { data: text(summary) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(MAX_AGENT_STEPS);
    expect(requests.at(-2)?.messages.at(-1)).toEqual({ role: "user", content: BUILD_CHECK_NUDGE });

    const last = requests.at(-1);
    expect(last?.tool_choice).toBe("none");
    expect(last?.messages.at(-1)).toEqual({ role: "user", content: STEP_BUDGET_NOTE });
    expect(JSON.stringify(last?.messages)).not.toContain(BUILD_CHECK_NUDGE);
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({ content: summary });
  });
});
