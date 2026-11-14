/**
 * Project instructions in a real `processMessage` run (#299): saved text goes
 * in the system prompt right after the base prompt, and nothing is added when
 * the project has none.
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

import { CODING_AGENT_SYSTEM_PROMPT } from "./constants";
import { drive, text } from "./process-message.driver";

let project: { ownerId: string; instructions?: string };

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => project,
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => [
    {
      key: "user:seo",
      name: "seo",
      description: "Use when adding seo",
      body: "# seo",
      source: "user",
      scope: "project",
      enabled: true,
      updatedAt: 1,
    },
  ],
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
}

const systemPrompt = async () => {
  const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [{ data: text("Done.") }]);
  const request = (outcome.inferenceBodies as ChatBody[]).find((body) => body.tools?.length);
  return String(request?.messages[0].content);
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage project instructions", () => {
  it("puts saved instructions right after the base prompt", async () => {
    project = { ownerId: "user_1", instructions: "Keep the green brand colour." };

    const prompt = await systemPrompt();

    expect(prompt).toContain(
      `${CODING_AGENT_SYSTEM_PROMPT}\n\n## Project instructions (from the user)`,
    );
    expect(prompt).toContain(
      "<project_instructions>\nKeep the green brand colour.\n</project_instructions>",
    );
    expect(prompt.indexOf("</project_instructions>")).toBeLessThan(
      prompt.indexOf("## Available skills"),
    );
  });

  it("adds nothing when the project has no instructions", async () => {
    project = { ownerId: "user_1" };

    const prompt = await systemPrompt();

    expect(prompt).not.toContain("## Project instructions");
    expect(prompt).toContain(`${CODING_AGENT_SYSTEM_PROMPT}\n\n## Available skills`);
  });
});
