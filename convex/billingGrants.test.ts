// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertGrant, MAX_ACTIVE_LOTS } from "./billingGrants";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const NOW = Date.UTC(2026, 9, 29, 10);
const DAY = 24 * 60 * 60 * 1000;
const mode = "test_mode" as const;

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

/** A billing customer and credit account for Alice; `versioned` turns paid lots on. */
const seed = (t: TestConvex, versioned = true, plan: "free" | "pro" = "pro") =>
  t.run(async (ctx) => {
    await ctx.db.insert("creditAccounts", {
      userId: ALICE, plan, periodStartsAt: Date.UTC(2026, 9, 1), periodUsed: 0,
      dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 0, ...(versioned ? { paidCreditsVersion: 1 as const } : {}),
    });
    return await ctx.db.insert("billingCustomers", {
      mode, ownerTokenIdentifier: `https://clerk.synthetic|${ALICE}`, userId: ALICE,
      creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
    });
  });

type Lot = { kind: "current_period" | "rollover" | "top_up"; quantity: number; expiresAt?: number; revoked?: number };
const grant = (t: TestConvex, customerRef: Id<"billingCustomers">, sourceKey: string, lot: Lot) =>
  t.run(async (ctx) => {
    const expiresAt = lot.expiresAt ?? NOW + 30 * DAY;
    const interval = lot.kind === "current_period" ? { serviceStart: NOW - DAY, serviceEnd: expiresAt } : {};
    const id = await insertGrant(ctx, { mode, sourceKey, customerRef, kind: lot.kind, quantity: lot.quantity, expiresAt, ...interval });
    if (lot.revoked) await ctx.db.patch("billingGrants", id, { revoked: lot.revoked });
    return id;
  });

const seedMessage = (t: TestConvex) =>
  t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: 1 });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 1 });
    return await ctx.db.insert("messages", {
      conversationId, projectId, role: "assistant", content: "", status: "processing",
      runModel: { modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    });
  });

/** Records a platform run whose running cost is `costUsd`: 150 credits per dollar. */
const charge = (t: TestConvex, messageId: Id<"messages">, costUsd: number) =>
  t.mutation(api.credits.recordRunUsage, {
    internalKey: INTERNAL_KEY, messageId, source: "platform", inputTokens: 1000, outputTokens: 100, costUsd,
  });

const consumed = (t: TestConvex) =>
  t.run(async (ctx) => (await ctx.db.query("billingGrants").take(200)).map((row) => [row.sourceKey, row.consumed]));
const rawAccount = (t: TestConvex) =>
  t.run((ctx) => ctx.db.query("creditAccounts").withIndex("by_userId", (q) => q.eq("userId", ALICE)).unique());

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("insertGrant", () => {
  test("is idempotent per mode and source key, and conflicts on changed terms", async () => {
    const t = setup();
    const customerRef = await seed(t);
    const first = await grant(t, customerRef, "period:sub_1:a:b", { kind: "current_period", quantity: 2000 });
    expect(await grant(t, customerRef, "period:sub_1:a:b", { kind: "current_period", quantity: 2000 })).toBe(first);
    await expect(grant(t, customerRef, "period:sub_1:a:b", { kind: "current_period", quantity: 1000 })).rejects.toThrow(/conflicts/);
    await expect(grant(t, customerRef, "period:sub_1:a:b", { kind: "top_up", quantity: 2000 })).rejects.toThrow(/conflicts/);
    expect(await t.run((ctx) => ctx.db.query("billingGrants").take(5))).toMatchObject([
      { userId: ALICE, quantity: 2000, consumed: 0, revoked: 0 },
    ]);
  });

  test("rejects invalid terms and a customer from another mode", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await expect(grant(t, customerRef, " ", { kind: "top_up", quantity: 1000 })).rejects.toThrow(/Invalid/);
    await expect(grant(t, customerRef, "k", { kind: "top_up", quantity: 0.5 })).rejects.toThrow(/Invalid/);
    await expect(
      t.run((ctx) => insertGrant(ctx, { mode, sourceKey: "k", customerRef, kind: "current_period", quantity: 1, expiresAt: NOW + DAY })),
    ).rejects.toThrow(/Invalid/);
    await expect(
      t.run((ctx) => insertGrant(ctx, { mode: "live_mode", sourceKey: "k", customerRef, kind: "top_up", quantity: 1, expiresAt: NOW + DAY })),
    ).rejects.toThrow(/conflicts/);
  });
});

describe("paid credit allocation in recordRunUsage", () => {
  test.each(["free", "pro"] as const)("a %s account without paidCreditsVersion is charged exactly as before", async (plan) => {
    const t = setup();
    const customerRef = await seed(t, false, plan);
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 1000 });
    const messageId = await seedMessage(t);
    await charge(t, messageId, 0.1);

    expect(await rawAccount(t)).toEqual({
      _id: expect.any(String), _creationTime: expect.any(Number), userId: ALICE, plan, periodStartsAt: Date.UTC(2026, 9, 1), periodUsed: 15,
      dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 15,
    });
    expect(await consumed(t)).toEqual([["top", 0]]);
  });

  test("spends new credits in order, and a replayed total spends nothing more", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "top_late", { kind: "top_up", quantity: 10, expiresAt: NOW + 90 * DAY });
    await grant(t, customerRef, "top_early", { kind: "top_up", quantity: 10, expiresAt: NOW + 60 * DAY });
    await grant(t, customerRef, "roll", { kind: "rollover", quantity: 3 });
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 6 });
    const messageId = await seedMessage(t);

    await charge(t, messageId, 0.04); // 6 credits
    await charge(t, messageId, 0.1); // 15 in all: 9 more
    await charge(t, messageId, 0.1); // replay
    await charge(t, messageId, 0.04); // older step replayed

    expect(await consumed(t)).toEqual([["top_late", 0], ["top_early", 6], ["roll", 3], ["cur", 6]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 15, dayUsed: 15 });
    expect((await rawAccount(t))!.creditDebt).toBeUndefined();
  });

  test("skips expired and revoked lots by server time", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "expired", { kind: "current_period", quantity: 100, expiresAt: NOW });
    await grant(t, customerRef, "revoked", { kind: "rollover", quantity: 100, revoked: 100 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 100 });
    await charge(t, await seedMessage(t), 0.1);
    expect(await consumed(t)).toEqual([["expired", 0], ["revoked", 0], ["top", 15]]);
  });

  test("records what lots can't cover as debt, keeping full usage", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 10 });
    const first = await seedMessage(t);
    const second = await seedMessage(t);

    await charge(t, first, 0.04); // 6
    await charge(t, second, 0.04); // 6 more: the lot has only 4 left
    await charge(t, second, 0.04); // replay

    expect(await consumed(t)).toEqual([["cur", 10]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 12, creditDebt: 2 });
  });

  test("dictation spends paid lots too", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 10 });
    await t.mutation(api.credits.recordTranscriptionUsage, { internalKey: INTERNAL_KEY, userId: ALICE, costUsd: 0.02 });
    expect(await consumed(t)).toEqual([["top", 3]]);
  });

  test("past the top-up cap, a charge the read lots cover succeeds and one they can't fails whole", async () => {
    const t = setup();
    const customerRef = await seed(t);
    for (let i = 0; i <= MAX_ACTIVE_LOTS.top_up; i++) {
      await grant(t, customerRef, `top_${String(i).padStart(3, "0")}`, { kind: "top_up", quantity: 1, expiresAt: NOW + (i + 1) * DAY });
    }
    await charge(t, await seedMessage(t), 0.04); // 6 credits from the 6 earliest lots
    const spent = (await consumed(t)).filter(([, n]) => n === 1).map(([key]) => key);
    expect(spent).toEqual(["top_000", "top_001", "top_002", "top_003", "top_004", "top_005"]);

    const big = await seedMessage(t);
    await expect(charge(t, big, 1)).rejects.toThrow(/Too many active paid credit lots/);
    expect(await t.run((ctx) => ctx.db.query("creditLedger").collect())).toHaveLength(1);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 6 });
  });
});
