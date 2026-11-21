// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";
const NOW = Date.UTC(2026, 9, 29, 10);
const DAY = 24 * 60 * 60 * 1000;
const OCT = Date.UTC(2026, 9, 1);

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;
type Mode = "test_mode" | "live_mode";

/** A billing-enabled account in `mode` with `freeUsed` of October's allocation spent. */
const seedAccount = (
  t: TestConvex,
  userId: string,
  fields: { freeUsed?: number; creditDebt?: number; freeMonthStartsAt?: number } = {},
  mode: Mode = "test_mode",
) =>
  t.run((ctx) =>
    ctx.db.insert("creditAccounts", {
      userId, plan: "free", periodStartsAt: OCT, periodUsed: 0, dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 0,
      paidCreditsVersion: 1, paidCreditsMode: mode, freeMonthStartsAt: fields.freeMonthStartsAt ?? OCT, freeUsed: fields.freeUsed ?? 0,
      freeDebtOffset: 0, creditDebt: fields.creditDebt,
    }),
  );

type Lot = { kind: "current_period" | "rollover" | "top_up"; quantity: number; consumed?: number; revoked?: number; expiresAt?: number; mode?: Mode };
const seedLot = (t: TestConvex, userId: string, lot: Lot) =>
  t.run(async (ctx) => {
    const mode = lot.mode ?? "test_mode";
    const customerRef = await ctx.db.insert("billingCustomers", {
      mode, ownerTokenIdentifier: `https://clerk.synthetic|${userId}`, userId,
      creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
    });
    const expiresAt = lot.expiresAt ?? NOW + 30 * DAY;
    const consumed = lot.consumed ?? 0;
    const revoked = lot.revoked ?? 0;
    await ctx.db.insert("billingGrants", {
      mode, sourceKey: `${userId}:${Math.random()}`, customerRef, userId, kind: lot.kind, quantity: lot.quantity,
      consumed, revoked, expiresAt,
      ...(lot.kind === "current_period" ? { serviceStart: expiresAt - 30 * DAY, serviceEnd: expiresAt } : {}),
      ...(consumed + revoked >= lot.quantity ? { exhausted: true as const } : {}),
    });
  });

const summary = (t: TestConvex, subject: string) => t.withIdentity({ subject }).query(api.billingSummary.mine, { now: NOW });

describe("billingSummary.mine", () => {
  test("refuses a signed-out caller", async () => {
    await expect(setup().query(api.billingSummary.mine, { now: NOW })).rejects.toThrow();
  });

  test("shows the legacy Free grant before billing is enabled", async () => {
    const t = setup();
    expect(await summary(t, ALICE)).toEqual({ plan: "free", paidThroughMs: null, paidCreditsRemaining: 0, freeRemaining: 300, debt: 0 });
    // Lots without a billing-enabled account don't count yet.
    await seedLot(t, ALICE, { kind: "top_up", quantity: 1000 });
    expect(await summary(t, ALICE)).toMatchObject({ paidCreditsRemaining: 0 });
  });

  test("Pro: counts only the caller's unspent, unexpired lots in the account's mode", async () => {
    const t = setup();
    await seedAccount(t, ALICE, { creditDebt: 40 });
    await seedLot(t, ALICE, { kind: "current_period", quantity: 2000, consumed: 500 });
    await seedLot(t, ALICE, { kind: "top_up", quantity: 1000, revoked: 200 });
    await seedLot(t, ALICE, { kind: "top_up", quantity: 1000, expiresAt: NOW - 1 });
    await seedLot(t, ALICE, { kind: "top_up", quantity: 1000, revoked: 1000 });
    await seedLot(t, ALICE, { kind: "top_up", quantity: 1000, mode: "live_mode" });
    await seedAccount(t, BOB);
    await seedLot(t, BOB, { kind: "top_up", quantity: 1000 });

    expect(await summary(t, ALICE)).toEqual({
      plan: "pro", paidThroughMs: NOW + 30 * DAY, paidCreditsRemaining: 2300, freeRemaining: null, debt: 40,
    });
    expect(await summary(t, BOB)).toEqual({
      plan: "free", paidThroughMs: null, paidCreditsRemaining: 1000, freeRemaining: 300, debt: 0,
    });
  });

  test("Free once the period lot expired: Free allocation left, retained top-ups kept", async () => {
    const t = setup();
    await seedAccount(t, ALICE, { freeUsed: 100 });
    await seedLot(t, ALICE, { kind: "current_period", quantity: 2000, expiresAt: NOW - 1 });
    await seedLot(t, ALICE, { kind: "top_up", quantity: 1000, consumed: 250 });

    expect(await summary(t, ALICE)).toEqual({
      plan: "free", paidThroughMs: null, paidCreditsRemaining: 750, freeRemaining: 200, debt: 0,
    });
  });

  test("Free in a new month: debt is shown net of the Free allocation that will pay it", async () => {
    const t = setup();
    // Last touched in September, so October's allocation hasn't been opened yet.
    await seedAccount(t, ALICE, { freeMonthStartsAt: Date.UTC(2026, 8, 1), freeUsed: 300, creditDebt: 40 });
    expect(await summary(t, ALICE)).toEqual({
      plan: "free", paidThroughMs: null, paidCreditsRemaining: 0, freeRemaining: 260, debt: 0,
    });
  });

  test("a live-mode period doesn't make a test-mode account Pro", async () => {
    const t = setup();
    await seedAccount(t, ALICE);
    await seedLot(t, ALICE, { kind: "current_period", quantity: 2000, mode: "live_mode" });
    expect(await summary(t, ALICE)).toMatchObject({ plan: "free", paidCreditsRemaining: 0 });
  });
});
