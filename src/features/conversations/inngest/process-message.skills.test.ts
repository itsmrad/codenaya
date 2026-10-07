/**
 * Skills in a real `processMessage` run: the enabled skills' index goes in the
 * system prompt, `loadSkill` returns a body from the run's resolved skills,
 * and the call is recorded as a step for the chat's run block.
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

const SEO_BODY = "# SEO\nAdd a sitemap.ts and metadata exports.";

const skill = (name: string, enabled = true) => ({
  key: `user:${name}`,
  name,
  description: `Use when adding ${name}`,
  body: name === "seo-metadata" ? SEO_BODY : `# ${name}`,
  source: "user",
  scope: "project",
  enabled,
  updatedAt: 1,
});

let projectSkills: () => unknown;

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => projectSkills(),
};

const loadSkillCall = (name: string) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_skill",
            type: "function",
            function: { name: "loadSkill", arguments: JSON.stringify({ name }) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
});

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

/** The coding agent's requests (the title agent's carry no tools). */
const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);

const systemPrompt = (body: ChatBody) => String(body.messages[0].content);
const toolNames = (body: ChatBody) => (body.tools ?? []).map((t) => t.function.name);

const PLATFORM_MODEL = { modelId: "x-ai/grok-4.7" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  projectSkills = () => [skill("seo-metadata"), skill("stripe", false)];
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage with skills", () => {
  it("indexes enabled skills and loads a body on demand", async () => {
    const outcome = await drive(PLATFORM_MODEL, [
      { data: text("SEO") },
      { data: loadSkillCall("seo-metadata") },
      { data: text("Added SEO metadata.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const [first, second] = codingRequests(outcome.inferenceBodies);
    const prompt = systemPrompt(first);
    expect(prompt).toContain("## Available skills");
    expect(prompt).toContain("- seo-metadata: Use when adding seo-metadata");
    expect(prompt).not.toContain(SEO_BODY);
    expect(prompt).not.toContain("stripe");
    expect(toolNames(first)).toContain("loadSkill");

    // The tool result fed back to the model carries the full body.
    expect(JSON.stringify(second.messages)).toContain("Add a sitemap.ts and metadata exports.");

    const steps = mocks.mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === "system:upsertMessageSteps")
      .flatMap(([, args]) => args.steps);
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "loadSkill", targets: ["seo-metadata"] }),
        expect.objectContaining({ tool: "loadSkill", status: "done" }),
      ]),
    );
    // Only the resolve step read skills: loading the body made no Convex call.
    expect(
      mocks.query.mock.calls.filter(([ref]) => getFunctionName(ref) === "system:getProjectSkills"),
    ).toHaveLength(1);
  });

  it("leaves the prompt and tools alone when no skill is enabled", async () => {
    projectSkills = () => [skill("stripe", false)];

    const outcome = await drive(PLATFORM_MODEL, [
      { data: text("Title") },
      { data: text("Done.") },
    ]);

    const [first] = codingRequests(outcome.inferenceBodies);
    expect(systemPrompt(first)).not.toContain("## Available skills");
    expect(toolNames(first)).not.toContain("loadSkill");
  });

  it("runs without skills when they cannot be loaded", async () => {
    projectSkills = () => {
      throw new Error("Convex unavailable");
    };

    const outcome = await drive(PLATFORM_MODEL, [
      { data: text("Title") },
      { data: text("Done.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(toolNames(codingRequests(outcome.inferenceBodies)[0])).not.toContain("loadSkill");
  });
});
