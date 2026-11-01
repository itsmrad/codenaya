/**
 * Conversation history in a real `processMessage` run (#293): earlier turns
 * reach the model as chat messages between the system prompt and the request,
 * and the system prompt does not change with them.
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

import { AGENT_FAILURE_MESSAGE } from "./lib/conversation-history";
import { drive, text } from "./process-message.driver";

type Stored = { _id: string; role: "user" | "assistant"; content: string; status?: string };

let recentMessages: Stored[] = [];

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => recentMessages,
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => [],
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
}

const firstCodingRequest = (bodies: unknown[]) =>
  (bodies as ChatBody[]).find((body) => body.tools?.length);

/** A conversation ending in the current request ("m1" is the run's reply). */
const conversation = (...earlier: Stored[]): Stored[] => [
  ...earlier,
  { _id: "u-now", role: "user", content: "Now make it dark" },
  { _id: "m1", role: "assistant", content: "", status: "processing" },
];

const run = async () =>
  firstCodingRequest(
    (await drive({ modelId: "x-ai/grok-4.7" }, [{ data: text("Done.") }], "Now make it dark"))
      .inferenceBodies,
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage conversation history", () => {
  it("sends earlier turns as messages, in order, before the request", async () => {
    recentMessages = conversation(
      { _id: "u1", role: "user", content: "Build a todo app" },
      { _id: "a1", role: "assistant", content: "Built a todo app.", status: "completed" },
      { _id: "u2", role: "user", content: "Add a chart" },
      { _id: "a2", role: "assistant", content: AGENT_FAILURE_MESSAGE, status: "completed" },
    );

    const request = await run();

    expect(request?.messages.map(({ role, content }) => ({ role, content })).slice(1)).toEqual([
      { role: "user", content: "Build a todo app" },
      { role: "assistant", content: "Built a todo app." },
      { role: "user", content: "Now make it dark" },
    ]);
    expect(request?.messages[0].role).toBe("system");
    expect(JSON.stringify(request?.messages[0])).not.toContain("Build a todo app");
  });

  it("keeps the system prompt byte-identical across runs with different history", async () => {
    recentMessages = conversation();
    const first = await run();

    recentMessages = conversation(
      { _id: "u1", role: "user", content: "Build a todo app" },
      { _id: "a1", role: "assistant", content: "Built a todo app.", status: "completed" },
    );
    const second = await run();

    expect(first?.messages).toHaveLength(2);
    expect(second?.messages).toHaveLength(4);
    expect(second?.messages[0]).toEqual(first?.messages[0]);
  });
});
