// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertGrant } from "./billingGrants";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const OCT = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const NOW = Date.UTC(2026, 10, 19, 10);
const DAY = 24 * 60 * 60 * 1000;
const mode = "test_mode" as const;

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

type AccountFields = {
  plan?: "free" | "pro"; enabled?: boolean; creditDebt?: number; periodUsed?: number;
  freeMonthStartsAt?: number; freeUsed?: number; half?: boolean;
};

/** A users row, billing customer and credit account for `userId`. */
const seed = (t: TestConvex, userId = ALICE, fields: AccountFields = {}) =>
  t.run(async (ctx) => {
    const { plan = "free", enabled = true, half = false, creditDebt, periodUsed = 0, freeMonthStartsAt = NOV, freeUsed = 0 } = fields;
    await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
    const markers = half ? { paidCreditsVersion: 1 as const } : enabled ? { paidCreditsVersion: 1 as const, paidCreditsMode: mode } : {};
    await ctx.db.insert("creditAccounts", {
      userId, plan, periodStartsAt: NOV, periodUsed, dayStartsAt: Date.UTC(2026, 10, 19), dayUsed: 0, ...markers,
      ...(enabled && !half ? { freeMonthStartsAt, freeUsed, freeDebtOffset: 0 } : {}),
      ...(creditDebt === undefined ? {} : { creditDebt }),
    });
    return await ctx.db.insert("billingCustomers", {
      mode, ownerTokenIdentifier: `https://clerk.synthetic|${userId}`, userId,
      creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
    });
  });

const grant = (t: TestConvex, customerRef: Id<"billingCustomers">, sourceKey: string, kind: "current_period" | "top_up", quantity: number,
  start = NOW - 10 * DAY, end = NOW + 20 * DAY) =>
  t.run((ctx) => insertGrant(ctx, {
    mode, sourceKey, customerRef, kind, quantity, expiresAt: end,
    ...(kind === "current_period" ? { serviceStart: start, serviceEnd: end } : {}),
  }));

const view = (t: TestConvex, userId = ALICE) => t.mutation(api.billingEntitlement.getForServer, { internalKey: INTERNAL_KEY, userId });
const permission = (t: TestConvex, userId = ALICE) =>
  t.mutation(api.billingEntitlement.permissionForServer, { internalKey: INTERNAL_KEY, userId });
const snapshot = (t: TestConvex) =>
  t.run(async (ctx) => ({ accounts: await ctx.db.query("creditAccounts").take(10), lots: await ctx.db.query("billingGrants").take(200) }));

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.stubEnv("CODENAYA_DEPLOYMENT", "development");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("billingEntitlement", () => {
  test("a user with no billing customer and no account is Free and allowed", async () => {
    const t = setup();
    expect(await view(t, BOB)).toMatchObject({ plan: "free", platformAllowed: true, reason: null, billingEnabled: false, creditsLeft: 60 });
    expect(await permission(t, BOB)).toEqual({ plan: "free", platformAllowed: true, reason: null });
  });

  test("a stale stored Pro plan on a legacy account gets the Free grant only", async () => {
    const t = setup();
    await seed(t, ALICE, { plan: "pro", enabled: false, periodUsed: 280 });
    expect(await view(t)).toMatchObject({ plan: "free", billingEnabled: false, freeRemaining: 20, creditsLeft: 20 });
  });

  test("a settled period is Pro with lots minus debt; spent still Pro; Bob is unaffected", async () => {
    const t = setup();
    const customer = await seed(t);
    await grant(t, customer, "period:1", "current_period", 2000);
    await t.run(async (ctx) => {
      const account = await ctx.db.query("creditAccounts").withIndex("by_userId", (q) => q.eq("userId", ALICE)).unique();
      await ctx.db.patch("creditAccounts", account!._id, { creditDebt: 100 });
    });
    expect(await view(t)).toMatchObject({
      plan: "pro", paidThroughMs: NOW + 20 * DAY, billingEnabled: true, creditsLeft: 1900, paidCreditsRemaining: 2000, debt: 100, dayLeft: null,
    });
    await t.run(async (ctx) => {
      const lot = await ctx.db.query("billingGrants").first();
      await ctx.db.patch("billingGrants", lot!._id, { consumed: 2000, exhausted: true });
    });
    expect(await permission(t)).toEqual({ plan: "pro", platformAllowed: true, reason: null });
    expect(await view(t)).toMatchObject({ plan: "pro", creditsLeft: 0 });
    expect(await view(t, BOB)).toMatchObject({ plan: "free", billingEnabled: false, paidCreditsRemaining: 0 });
  });

  test("a fully reversed period is Free; a future period is Free until it starts", async () => {
    const t = setup();
    const customer = await seed(t);
    const id = await grant(t, customer, "period:1", "current_period", 2000);
    await t.run((ctx) => ctx.db.patch("billingGrants", id, { consumed: 500, revoked: 2000, fullyReversed: true, exhausted: true }));
    expect(await permission(t)).toMatchObject({ plan: "free" });
    await grant(t, customer, "period:2", "current_period", 2000, NOW + DAY, NOW + 31 * DAY);
    expect(await view(t)).toMatchObject({ plan: "free", nextChangeAt: NOW + DAY });
    vi.setSystemTime(NOW + DAY);
    expect(await view(t)).toMatchObject({ plan: "pro", paidThroughMs: NOW + 31 * DAY });
  });

  test("holds keep the paid label but stop platform use", async () => {
    const t = setup();
    const customer = await seed(t);
    await grant(t, customer, "period:1", "current_period", 2000);
    await t.run((ctx) => ctx.db.insert("billingAdjustments", {
      mode, customerRef: customer, paymentId: "pay_1", kind: "dispute", providerId: "dsp_1", status: "dispute_opened",
      countedMinor: 0, holdActive: true, observedAt: NOW,
    }));
    expect(await view(t)).toMatchObject({ plan: "pro", platformAllowed: false, reason: "on_hold", creditsLeft: 0, paidCreditsRemaining: 2000 });
    await t.run(async (ctx) => {
      const adjustment = await ctx.db.query("billingAdjustments").first();
      await ctx.db.patch("billingAdjustments", adjustment!._id, { holdActive: false });
      await ctx.db.patch("billingCustomers", customer, { hold: true });
    });
    expect(await permission(t)).toEqual({ plan: "pro", platformAllowed: false, reason: "on_hold" });
  });

  test("a deleted user, or a billing customer whose owner row is gone, has no access", async () => {
    const t = setup();
    await seed(t);
    await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      await ctx.db.patch("users", user!._id, { deletedAt: NOW });
    });
    expect(await view(t)).toMatchObject({ platformAllowed: false, reason: "deleted", creditsLeft: 0 });
    await seed(t, BOB);
    await t.run(async (ctx) => {
      const bob = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", BOB)).unique();
      await ctx.db.delete("users", bob!._id);
    });
    expect(await permission(t, BOB)).toEqual({ plan: "free", platformAllowed: false, reason: "deleted" });
  });

  test("paid benefits stay in this deployment's mode; unknown mode and half markers fail closed", async () => {
    const t = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const customer = await seed(t);
    await grant(t, customer, "period:1", "current_period", 2000);
    vi.stubEnv("CODENAYA_DEPLOYMENT", "production");
    expect(await view(t)).toMatchObject({ plan: "free", billingEnabled: false, paidCreditsRemaining: 0 });
    expect(warn).toHaveBeenLastCalledWith(`[billingEntitlement] foreign_mode_marker: userId=${ALICE}`);
    vi.stubEnv("CODENAYA_DEPLOYMENT", "");
    await t.run((ctx) => ctx.db.patch("billingCustomers", customer, { hold: true }));
    expect(await permission(t)).toEqual({ plan: "free", platformAllowed: false, reason: "on_hold" });
    expect(warn).toHaveBeenLastCalledWith(`[billingEntitlement] deployment_mode_unknown: userId=${ALICE}`);

    vi.stubEnv("CODENAYA_DEPLOYMENT", "development");
    const bobCustomer = await seed(t, BOB, { half: true });
    await grant(t, bobCustomer, "period:b", "current_period", 2000);
    expect(await view(t, BOB)).toMatchObject({ plan: "free", billingEnabled: false });
    expect(warn).toHaveBeenLastCalledWith(`[billingEntitlement] half_paid_marker: userId=${BOB}`);
  });

  test("a new month shows debt paid from Free without writing; the first charge persists the same projection", async () => {
    const t = setup();
    await seed(t, ALICE, { freeMonthStartsAt: OCT, freeUsed: 300, creditDebt: 40 });
    const before = await snapshot(t);
    expect(await view(t)).toMatchObject({ plan: "free", freeRemaining: 260, debt: 0, creditsLeft: 60 });
    expect(await view(t)).toMatchObject({ freeRemaining: 260, debt: 0 });
    expect(await snapshot(t)).toEqual(before);

    const messageId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: 1 });
      const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 1 });
      return await ctx.db.insert("messages", { conversationId, projectId, role: "assistant", content: "", status: "processing" });
    });
    // $0.10 is 15 credits.
    await t.mutation(api.credits.recordRunUsage, {
      internalKey: INTERNAL_KEY, messageId, source: "platform", inputTokens: 1000, outputTokens: 100, costUsd: 0.1,
    });
    expect(await view(t)).toMatchObject({ freeRemaining: 245, debt: 0, creditsLeft: 45 });
  });

  test("500 debt in a new month leaves 200 debt and nothing to spend", async () => {
    const t = setup();
    await seed(t, ALICE, { freeMonthStartsAt: OCT, freeUsed: 300, creditDebt: 500 });
    expect(await view(t)).toMatchObject({ freeRemaining: 0, debt: 200, creditsLeft: 0 });
  });

  test("past the top-up cap the display counts only the lots spending reads", async () => {
    const t = setup();
    const customer = await seed(t, ALICE, { freeUsed: 300 });
    for (let i = 0; i < 101; i++) await grant(t, customer, `top_up:${i}`, "top_up", 1);
    expect(await view(t)).toMatchObject({ plan: "free", paidCreditsRemaining: 100, creditsLeft: 60 });
  });

  test("authorization takes no caller clock", async () => {
    const t = setup();
    await expect(
      t.mutation(api.billingEntitlement.getForServer, { internalKey: INTERNAL_KEY, userId: ALICE, now: 0 } as never),
    ).rejects.toThrow();
    await expect(t.mutation(api.billingEntitlement.permissionForServer, { internalKey: "wrong", userId: ALICE })).rejects.toThrow();
  });
});
