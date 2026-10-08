/**
 * Plan mode (#120) in a real `processMessage` run: the coding agent gets only
 * read tools, the prompt asks for a plan, and no checkpoint is taken.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { drive, text } from "./process-message.driver";

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => [
    {
      key: "user:seo",
      name: "seo",
      description: "Use when adding SEO",
      body: "# SEO",
      source: "user",
      scope: "project",
      enabled: true,
      updatedAt: 1,
    },
  ],
};

const WRITE_TOOLS = [
  "updateFile",
  "createFiles",
  "createFolder",
  "renameFile",
  "deleteFiles",
  "setEnvVar",
];

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

const codingRequest = (bodies: unknown[]) =>
  (bodies as ChatBody[]).find((body) => body.tools)!;
const toolNames = (body: ChatBody) => (body.tools ?? []).map((t) => t.function.name);
const mutationNames = () =>
  mocks.mutation.mock.calls.map(([ref]) => getFunctionName(ref));

const PLAN = "### Steps\n- [ ] Add a todo list page";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage in plan mode", () => {
  it("registers no write tools and replies with the plan", async () => {
    const outcome = await drive(
      { modelId: "x-ai/grok-4.7" },
      [{ data: text("Todo app") }, { data: text(PLAN) }],
      "todo app",
      { mode: "plan" },
    );

    expect(outcome.finalType).toBe("function-resolved");
    const body = codingRequest(outcome.inferenceBodies);
    expect(toolNames(body).sort()).toEqual(
      ["listFiles", "loadSkill", "readFiles", "scrapeUrls"].sort(),
    );
    expect(String(body.messages[0].content)).toContain("## Plan mode");
    expect(mutationNames()).not.toContain("system:createProjectCheckpoint");
    expect(mocks.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: "m1", content: PLAN }),
    );
  });

  it("keeps the write tools and checkpoint in build mode", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Todo app") },
      { data: text("Built it.") },
    ]);

    const body = codingRequest(outcome.inferenceBodies);
    expect(toolNames(body)).toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(String(body.messages[0].content)).not.toContain("## Plan mode");
    expect(mutationNames()).toContain("system:createProjectCheckpoint");
  });
});
