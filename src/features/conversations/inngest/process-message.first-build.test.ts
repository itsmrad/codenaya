/**
 * The first-build critical path (#338) in a real `processMessage` run: the
 * title runs alongside the coding agent instead of before it, and a project
 * seeded with the starter gets its ids in the prompt.
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

const codingPrompt = (bodies: unknown[]) =>
  JSON.stringify((bodies as ChatBody[]).find((body) => body.tools)!.messages[0]);
const mutations = () =>
  mocks.mutation.mock.calls.map(([ref, args]) => [getFunctionName(ref), args]);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
  projectFiles = [];
});

describe("processMessage first build", () => {
  it("requests the first coding turn together with the title, then still saves the title", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Todo app") },
      { data: text("Built it.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const [title, coding] = outcome.inferenceRequests;
    expect(coding).toBe(title);
    expect(mutations()).toEqual(
      expect.arrayContaining([
        ["system:updateConversationTitle", expect.objectContaining({ title: "Todo app" })],
        ["system:updateMessageContent", expect.objectContaining({ content: "Built it." })],
      ]),
    );
  });

  it("finishes the run with the default title when title generation fails", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { error: { name: "Error", message: "AI request failed with status 500" } },
      { data: text("Built it.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const names = mutations().map(([name]) => name);
    expect(names).not.toContain("system:updateConversationTitle");
    expect(mutations()).toContainEqual([
      "system:updateMessageContent",
      expect.objectContaining({ content: "Built it." }),
    ]);
  });

  it("gives a starter-only project its file ids, so the first turn needs no listFiles", async () => {
    projectFiles = VITE_REACT_STARTER.map(({ path }) => ({
      _id: `id:${path}`,
      name: path,
      type: "file",
    }));

    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Todo app") },
      { data: text("Built it.") },
    ]);

    const prompt = codingPrompt(outcome.inferenceBodies);
    expect(prompt).toContain("Do not call listFiles or scaffoldViteApp");
    expect(prompt).toContain("package.json (file, id: id:package.json)");
  });

  it("leaves the prompt without a workspace section for any other project", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Todo app") },
      { data: text("Built it.") },
    ]);

    expect(codingPrompt(outcome.inferenceBodies)).not.toContain("## Workspace");
  });
});
