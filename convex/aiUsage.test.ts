// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ADMIN = { subject: "user_admin", email: "admin@example.com", emailVerified: true };
const INTERNAL_KEY = "test-internal-key";
const OCT = Date.UTC(2026, 9, 15);

const setup = async () => {
  const t = convexTest(schema, modules);
  // $3/$15 per 1M tokens on "sonnet" (the default), $1/$2 on "mini".
  await t.withIdentity(ADMIN).mutation(api.platformModels.save, {
    provider: "openrouter",
    defaultModelId: "sonnet",
    models: [
      { id: "sonnet", name: "Sonnet", vendor: "acme", vision: false, tools: "reported", inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
      { id: "mini", name: "Mini", vendor: "acme", vision: false, tools: "reported", inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    ],
  });
  return t;
};

type T = Awaited<ReturnType<typeof setup>>;

const record = (t: T, key: string, overrides: Record<string, unknown> = {}) =>
  t.mutation(api.aiUsage.record, {
    internalKey: INTERNAL_KEY,
    key,
    userId: "user_1",
    source: "agent",
    provider: "openrouter",
    modelId: "sonnet",
    inputTokens: 1_234,
    outputTokens: 567,
    ...overrides,
  });

const setLimits = (t: T, limits: { monthlyUsdLimit?: number; monthlyTokenLimit?: number }) =>
  t.withIdentity(ADMIN).mutation(api.planLimits.setPlanLimits, { planId: "free", ...limits });

const status = (t: T, month = "2026-10") =>
  t.query(api.aiUsage.checkLimit, { internalKey: INTERNAL_KEY, userId: "user_1", month });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OCT);
  vi.stubEnv("ADMIN_EMAIL", ADMIN.email);
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("aiUsage.record", () => {
  test("costs integer micro-USD: 1,234 in × $3 + 567 out × $15 = 12,207 µUSD", async () => {
    const t = await setup();
    expect(await record(t, "run:t0")).toMatchObject({ costMicroUsd: 12_207, tokens: 1_801, exceeded: false });
  });

  test("the same key recorded twice counts once, in tokens and USD (Inngest retry)", async () => {
    const t = await setup();
    await record(t, "run:t0");
    const again = await record(t, "run:t0", { inputTokens: 999_999 });

    expect(again).toMatchObject({ costMicroUsd: 12_207, tokens: 1_801 });
    expect(await status(t)).toMatchObject({ costMicroUsd: 12_207, tokens: 1_801 });
    const events = await t.run((ctx) => ctx.db.query("aiUsageEvents").take(10));
    expect(events).toHaveLength(1);
  });

  test("an unlisted model is charged at the default model's price", async () => {
    const t = await setup();
    expect(await record(t, "run:title", { modelId: "openai/gpt-5.4-mini" })).toMatchObject({ costMicroUsd: 12_207 });
    expect(await record(t, "run:t0", { modelId: "mini" })).toMatchObject({ costMicroUsd: 12_207 + 2_368 });
  });

  test("a provider without saved prices is never free: it pays the fallback rate", async () => {
    const t = await setup();
    // 1,234 × $15 + 567 × $75 per 1M tokens.
    expect(await record(t, "run:t0", { provider: "groq" })).toMatchObject({ costMicroUsd: 61_035, tokens: 1_801 });
    const [event] = await t.run((ctx) => ctx.db.query("aiUsageEvents").take(1));
    expect(event).toMatchObject({ priced: false, costMicroUsd: 61_035 });
  });

  test("a new UTC month starts a new total", async () => {
    const t = await setup();
    vi.setSystemTime(Date.UTC(2026, 9, 31, 23, 59, 59));
    await record(t, "run:a");
    vi.setSystemTime(Date.UTC(2026, 10, 1));
    await record(t, "run:b");

    expect(await status(t, "2026-10")).toMatchObject({ costMicroUsd: 12_207 });
    expect(await status(t, "2026-11")).toMatchObject({ costMicroUsd: 12_207 });
    const rows = await t.run((ctx) => ctx.db.query("aiUsageMonthly").take(10));
    expect(rows.map((row) => row.month).sort()).toEqual(["2026-10", "2026-11"]);
  });

  test("rejects a bad internal key and bad token counts", async () => {
    const t = await setup();
    await expect(record(t, "run:t0", { internalKey: "wrong" })).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
    for (const inputTokens of [-1, 1.5, 10_000_001]) {
      await expect(record(t, "run:t0", { inputTokens })).rejects.toMatchObject({
        data: { code: "INVALID_ARGUMENT" },
      });
    }
  });
});

describe("caps", () => {
  test("no saved limits: the Free default of $3, no token cap", async () => {
    const t = await setup();
    expect(await status(t)).toEqual({
      planId: "free",
      costMicroUsd: 0,
      tokens: 0,
      costLimitMicroUsd: 3_000_000,
      exceeded: false,
    });
  });

  test("blocks exactly at the USD cap, not one µUSD before", async () => {
    const t = await setup();
    await setLimits(t, { monthlyUsdLimit: 0.012208 });
    expect(await record(t, "run:t0")).toMatchObject({ exceeded: false });

    await setLimits(t, { monthlyUsdLimit: 0.012207 });
    expect(await status(t)).toMatchObject({ exceeded: true, exceededBy: "usd" });
  });

  test("the token cap blocks under the USD cap, and at exactly the cap", async () => {
    const t = await setup();
    await setLimits(t, { monthlyUsdLimit: 100, monthlyTokenLimit: 1_802 });
    expect(await record(t, "run:t0")).toMatchObject({ exceeded: false });

    await setLimits(t, { monthlyUsdLimit: 100, monthlyTokenLimit: 1_801 });
    expect(await status(t)).toMatchObject({ exceeded: true, exceededBy: "tokens" });
  });

  test("a cap of 0 blocks before any use; both caps off never blocks", async () => {
    const t = await setup();
    await setLimits(t, { monthlyUsdLimit: 0 });
    expect(await status(t)).toMatchObject({ exceeded: true, exceededBy: "usd" });

    await setLimits(t, {});
    await record(t, "run:t0", { inputTokens: 10_000_000, outputTokens: 10_000_000 });
    expect(await status(t)).toMatchObject({ exceeded: false, costMicroUsd: 180_000_000 });
  });

  test("the send path reads usage in the same query as the platform", async () => {
    const t = await setup();
    await record(t, "run:t0");
    const active = await t.query(api.platformModels.getActiveForServer, {
      internalKey: INTERNAL_KEY,
      fallbackProvider: "openrouter",
      usageOf: { userId: "user_1", month: "2026-10" },
    });
    expect(active.usage).toMatchObject({ costMicroUsd: 12_207, exceeded: false });
  });
});

describe("myUsage and listTopSpenders", () => {
  test("myUsage returns only the caller's usage", async () => {
    const t = await setup();
    await record(t, "run:a");
    await record(t, "run:b", { userId: "user_2", inputTokens: 1 });

    const mine = await t.withIdentity({ subject: "user_2" }).query(api.aiUsage.myUsage, { month: "2026-10" });
    expect(mine).toMatchObject({ tokens: 568 });
    await expect(t.query(api.aiUsage.myUsage, { month: "2026-10" })).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
    await expect(
      t.withIdentity({ subject: "user_2" }).query(api.aiUsage.myUsage, { month: "2026-13" }),
    ).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
  });

  test("lists the month's top spenders first, paginated, admin only", async () => {
    const t = await setup();
    await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "user_2", email: "big@example.com", name: "Big", updatedAt: 1 }));
    await record(t, "run:a", { userId: "user_1", inputTokens: 10 });
    await record(t, "run:b", { userId: "user_2" });
    await record(t, "run:c", { userId: "user_3", inputTokens: 100 });

    const admin = t.withIdentity(ADMIN);
    const first = await admin.query(api.aiUsage.listTopSpenders, {
      month: "2026-10",
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map((row) => row.userId)).toEqual(["user_2", "user_3"]);
    expect(first.page[0]).toMatchObject({ email: "big@example.com", planId: "free", costLimitMicroUsd: 3_000_000 });
    const rest = await admin.query(api.aiUsage.listTopSpenders, {
      month: "2026-10",
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(rest.page.map((row) => row.userId)).toEqual(["user_1"]);

    await expect(
      t.withIdentity({ subject: "user_1", email: "u@example.com", emailVerified: true }).query(
        api.aiUsage.listTopSpenders,
        { month: "2026-10", paginationOpts: { numItems: 2, cursor: null } },
      ),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});
