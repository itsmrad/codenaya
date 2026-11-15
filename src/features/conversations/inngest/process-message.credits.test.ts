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
  account: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.catalog, mocks.account), mutation: mocks.mutation } };
});

import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { drive, text, toolCall } from "./process-message.driver";

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
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
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


describe("processMessage credit limit", () => {
  beforeEach(() => {
    vi.stubEnv("CREDIT_LIMITS_ENFORCED", "true");
    const now = Date.now();
    mocks.account.mockReturnValue({ plan: "free", periodStartsAt: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1),
      periodUsed: 57, dayStartsAt: new Date(now).setUTCHours(0, 0, 0, 0), dayUsed: 57 });
    mocks.query.mockImplementation(async (ref) => getFunctionName(ref) === "system:getConversationById"
      ? { title: "Existing chat" } : getFunctionName(ref) === "promoClaims:hasClaimForProjectOwner"
        ? true : QUERIES[getFunctionName(ref)]?.());
  });

  it.each([3, 4])("stops at a %i-credit balance and continues while below it", async (left) => {
    const account = mocks.account();
    mocks.account.mockReturnValue({ ...account, dayUsed: 60 - left });
    const inference = { ...toolCall("listFiles"), usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } }; // $0.02 = 3 credits
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: inference },
      ...(left > 3 ? [{ data: inference }] : []),
      { data: text("Listed files; work remains.") },
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(left > 3 ? 3 : 2);
    expect(JSON.stringify(outcome.inferenceBodies.at(-1))).toContain("ran out of credits");
    const reply = mocks.mutation.mock.calls.find(([ref]) => getFunctionName(ref) === "system:updateMessageContent")?.[1];
    expect(reply.content).toContain("ran out of credits");
    expect(reply.outcome).not.toBe("error");
    expect(mocks.account).toHaveBeenCalledTimes(2); // explicit fixture read plus one durable snapshot
  });

  it("keeps the real final answer when its text-only turn crosses the limit", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: withUsage("The real final answer.", 2_000, 2_000) }, // 6 credits, balance 3
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(1);
    const reply = mocks.mutation.mock.calls.find(([ref]) => getFunctionName(ref) === "system:updateMessageContent")?.[1];
    expect(reply.content).toContain("The real final answer.");
    expect(reply.outcome).not.toBe("error");
  });

  it.each([false, true])("excludes title cost from routing even when its completion is held: %s", async (held) => {
    mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: withUsage("Expensive title", 100_000, 100_000), held }, // $0.20 on mini exceeds the balance
      { data: { ...toolCall("listFiles"), usage: { prompt_tokens: 100, completion_tokens: 100 } } },
      { data: withUsage("The real final answer.", 100, 100) }, // coding total $0.004 stays below it
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceBodies).toHaveLength(3); // title plus two coding turns, no summary
    expect(JSON.stringify(outcome.inferenceBodies)).not.toContain("ran out of credits");
    const reply = mocks.mutation.mock.calls.find(([ref]) => getFunctionName(ref) === "system:updateMessageContent")?.[1];
    expect(reply.content).toBe("The real final answer.");
    expect(usageRecords().at(-1).costUsd).toBeCloseTo(0.204, 10); // settlement still bills the title
  });

  it.each(["promo", "unenforced"])("leaves %s runs uncapped", async (kind) => {
    if (kind === "promo") mocks.catalog.mockReturnValue({ ...CATALOG, models: CATALOG.models.map((m) => ({ ...m, access: "promo_unlimited" })) });
    else vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: { ...toolCall("listFiles"), usage: { prompt_tokens: 10_000, completion_tokens: 10_000 } } },
      { data: text("Finished normally.") },
    ]);
    expect(outcome.finalType).toBe("function-resolved");
    expect(JSON.stringify(outcome.inferenceBodies.at(-1))).not.toContain("ran out of credits");
    expect(mocks.account).not.toHaveBeenCalled();
  });
});
