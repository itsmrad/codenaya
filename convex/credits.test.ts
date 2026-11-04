// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const OCT_29 = Date.UTC(2026, 9, 29, 10);

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

/** An assistant message on a project `ownerId` owns. */
const seedMessage = (t: TestConvex, ownerId = ALICE) =>
  t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId, updatedAt: 1 });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 1 });
    return await ctx.db.insert("messages", {
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
      runModel: { modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    });
  });

const record = (
  t: TestConvex,
  messageId: Awaited<ReturnType<typeof seedMessage>>,
  totals: { inputTokens: number; outputTokens: number; costUsd: number },
  source: "platform" | "promo" | "byok" = "platform",
) => t.mutation(api.credits.recordRunUsage, { internalKey: INTERNAL_KEY, messageId, source, ...totals });

const account = (t: TestConvex, userId = ALICE) =>
  t.query(api.credits.getForServer, { internalKey: INTERNAL_KEY, userId });

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OCT_29);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("credits.recordRunUsage", () => {
  test("charges a platform run's running total once, to the project owner", async () => {
    const t = setup();
    const messageId = await seedMessage(t);

    await record(t, messageId, { inputTokens: 1000, outputTokens: 100, costUsd: 0.04 }); // 6 credits
    await record(t, messageId, { inputTokens: 3000, outputTokens: 400, costUsd: 0.1 }); // 15 in all
    // A replayed or retried earlier step: smaller totals change nothing.
    await record(t, messageId, { inputTokens: 1000, outputTokens: 100, costUsd: 0.04 });
    await record(t, messageId, { inputTokens: 3000, outputTokens: 400, costUsd: 0.1 });

    expect(await account(t)).toEqual({
      plan: "free",
      periodStartsAt: Date.UTC(2026, 9, 1),
      periodUsed: 15,
      dayStartsAt: Date.UTC(2026, 9, 29),
      dayUsed: 15,
    });
    const rows = await t.run((ctx) => ctx.db.query("creditLedger").collect());
    expect(rows).toMatchObject([
      { userId: ALICE, messageId, source: "platform", model: "GPT-5.6 Luna", inputTokens: 3000, credits: 15 },
    ]);
  });

  test("records BYOK and promo runs at 0 credits", async () => {
    const t = setup();
    await record(t, await seedMessage(t), { inputTokens: 500, outputTokens: 50, costUsd: 0 }, "byok");
    await record(t, await seedMessage(t), { inputTokens: 500, outputTokens: 50, costUsd: 0.2 }, "promo");

    expect(await account(t)).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("creditLedger").collect());
    expect(rows.map((row) => [row.source, row.credits])).toEqual([
      ["byok", 0],
      ["promo", 0],
    ]);
  });

  test("starts a new day and month from zero", async () => {
    const t = setup();
    await record(t, await seedMessage(t), { inputTokens: 1, outputTokens: 1, costUsd: 0.2 }); // 30

    vi.setSystemTime(Date.UTC(2026, 9, 30, 1));
    await record(t, await seedMessage(t), { inputTokens: 1, outputTokens: 1, costUsd: 0.02 }); // 3
    expect(await account(t)).toMatchObject({ periodUsed: 33, dayUsed: 3 });

    vi.setSystemTime(Date.UTC(2026, 10, 1, 1));
    await record(t, await seedMessage(t), { inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
    expect(await account(t)).toMatchObject({ periodStartsAt: Date.UTC(2026, 10, 1), periodUsed: 3, dayUsed: 3 });
  });

  test("rejects totals that aren't finite or are negative, and never lowers one", async () => {
    const t = setup();
    const messageId = await seedMessage(t);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(record(t, messageId, { inputTokens: 1, outputTokens: 1, costUsd: bad })).rejects.toThrow();
    }
    expect(await account(t)).toBeNull();

    await record(t, messageId, { inputTokens: 100, outputTokens: 10, costUsd: 0.1 });
    // Out of order: more input, less output than stored.
    await record(t, messageId, { inputTokens: 200, outputTokens: 5, costUsd: 0.1 });
    const [row] = await t.run((ctx) => ctx.db.query("creditLedger").collect());
    expect(row).toMatchObject({ inputTokens: 200, outputTokens: 10, costUsd: 0.1, credits: 15 });
    expect(await account(t)).toMatchObject({ periodUsed: 15 });
  });

  test("refuses a wrong internal key", async () => {
    const t = setup();
    const messageId = await seedMessage(t);
    await expect(
      t.mutation(api.credits.recordRunUsage, {
        internalKey: "wrong",
        messageId,
        source: "platform",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 1,
      }),
    ).rejects.toThrow();
    await expect(t.query(api.credits.getForServer, { internalKey: "wrong", userId: ALICE })).rejects.toThrow();
    expect(await account(t)).toBeNull();
  });
});

describe("credits.getMine", () => {
  test("returns only the caller's own account, and needs sign-in", async () => {
    const t = setup();
    await record(t, await seedMessage(t, ALICE), { inputTokens: 1, outputTokens: 1, costUsd: 0.1 });

    expect(await t.withIdentity({ subject: ALICE }).query(api.credits.getMine, {})).toMatchObject({
      periodUsed: 15,
    });
    expect(await t.withIdentity({ subject: BOB }).query(api.credits.getMine, {})).toBeNull();
    await expect(t.query(api.credits.getMine, {})).rejects.toThrow();
  });
});
