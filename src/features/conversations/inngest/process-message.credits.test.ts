/**
 * Credit metering (ADR 0011) in a real `processMessage` run: every inference,
 * the title included, records the run's running totals at the catalog's price.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.catalog), mutation: mocks.mutation } };
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

const model = (id: string, usdPerMTok: number) => ({
  id,
  name: id,
  vendor: "x",
  provider: "openrouter",
  providerModelId: id,
  vision: false,
  tools: "reported",
  pricing: { mode: "blended", usdPerMTok },
  access: "everyone",
  hidden: false,
});

const CATALOG = {
  models: [model("x-ai/grok-4.7", 10), model("mini", 1)],
  defaultModelId: "x-ai/grok-4.7",
  utilityModelId: "mini",
};

const withUsage = (content: string, prompt_tokens: number, completion_tokens: number) => ({
  ...text(content),
  usage: { prompt_tokens, completion_tokens },
});

const usageRecords = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "credits:recordRunUsage")
    .map(([, args]) => args);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
  mocks.catalog.mockReturnValue(CATALOG);
});

describe("processMessage credit metering", () => {
  it("records the title and each coding inference as running totals, each at its route's price", async () => {
    await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: withUsage("Todo app", 900, 100) }, // title on mini: $0.001
      { data: withUsage("Built it.", 1_000, 1_000) }, // coding on grok: $0.02
    ]);

    const records = usageRecords();
    // One per inference, then the final one that catches up a failed last record.
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({
      internalKey: "ik",
      messageId: "m1",
      source: "platform",
      inputTokens: 900,
      outputTokens: 100,
      costUsd: 0.001,
    });
    expect(records[1]).toMatchObject({ inputTokens: 1_900, outputTokens: 1_100 });
    expect(records[1].costUsd).toBeCloseTo(0.021, 10);
    expect(records[2]).toEqual(records[1]);
  });

  it("still finishes the run when recording usage fails", async () => {
    mocks.mutation.mockImplementation(async (ref) => {
      if (getFunctionName(ref) === "credits:recordRunUsage") throw new Error("Convex down");
      return null;
    });

    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: withUsage("Todo app", 1, 1) },
      { data: withUsage("Built it.", 1, 1) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
  });
});
