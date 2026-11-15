/**
 * Follow-up chips (#256) in a real `processMessage` run: the reply's
 * `<suggestions>` block is stored apart from the content, which never has it.
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
import { drive, text } from "./process-message.driver";

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

const finalUpdate = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "system:updateMessageContent")
    .at(-1)?.[1];

describe("processMessage follow-up suggestions", () => {
  it("stores the suggestions apart from the reply", async () => {
    await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Todo app") },
      { data: text("- Answered.\n\n<suggestions>\nAdd a footer\nAdd dark mode\n</suggestions>") },
    ]);

    expect(finalUpdate()).toMatchObject({
      content: "- Answered.",
      suggestions: ["Add a footer", "Add dark mode"],
    });
  });

  it("stores none for a reply without the block", async () => {
    await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Todo app") },
      { data: text("- Answered.") },
    ]);

    expect(finalUpdate()).toMatchObject({ content: "- Answered." });
    expect(finalUpdate()).not.toHaveProperty("suggestions");
  });
});
