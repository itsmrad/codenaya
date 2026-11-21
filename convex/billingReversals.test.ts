// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isInPaidPeriod } from "../src/features/billing/grants";
import { decideReversal, type ProviderDispute, type ProviderRefund } from "../src/features/billing/reversals";
import type { ProviderPayment } from "../src/features/billing/settlement";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { readPeriodLots, spendPaidCredits } from "./billingGrants";
import { hasActiveHold } from "./billingReversals";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const NOW = Date.UTC(2026, 10, 10, 12);
const P1 = { serviceStart: Date.UTC(2026, 10, 1), serviceEnd: Date.UTC(2026, 11, 1) };
const P2 = { serviceStart: P1.serviceEnd, serviceEnd: Date.UTC(2027, 0, 1) };
const PRO = "pdt_pro";
const TOP_UP = "pdt_topup";
const TOTAL = 2000;
const mode = "test_mode" as const;
const setup = () => convexTest(schema, modules);
type T = ReturnType<typeof setup>;
type Ref = Id<"billingCustomers">;
type Adjustments = NonNullable<ProviderPayment["adjustments"]>;

const logs: unknown[][] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  logs.length = 0;
  for (const level of ["error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const logged = (message: string) => logs.some(([first]) => first === message);

async function customer(t: T, userId = "user_alice") {
  await t.run(ctx => ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 }));
  const customerRef = await t.mutation(internal.billing.ensureCustomer, { mode, userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}` });
  await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: `cus_${userId}` });
  return customerRef;
}

async function checkout(t: T, customerRef: Ref, sku: "pro_monthly" | "top_up", n = 1) {
  const pro = sku === "pro_monthly";
  const purchaseRef = await t.mutation(internal.billing.reservePurchase, {
    customerRef, intentId: `intent_${n}`, terms: { sku, catalogVersion: "2026-11-17", productId: pro ? PRO : TOP_UP, quantity: 1, credits: pro ? 2000 : 1000 },
  });
  if (pro) await t.mutation(internal.billing.bindSubscription, { customerRef, mode, subscriptionId: "sub_1", productId: PRO });
  await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, sessionId: `cks_${n}`, ...(pro ? { subscriptionId: "sub_1" } : {}) });
  return purchaseRef;
}

let seq = 0;
const receive = (t: T, customerRef: Ref, eventType: string, paymentId: string) =>
  t.mutation(internal.billing.recordReceipt, { customerRef, mode, webhookId: `wh_${++seq}`, eventType, bodyDigest: "a".repeat(64), occurredAt: 1, paymentId });

const refund = (refundId: string, amountMinor: number | null, status: ProviderRefund["status"] = "succeeded", isPartial = amountMinor !== TOTAL): ProviderRefund =>
  ({ refundId, status, amountMinor, currency: "USD", isPartial });
const dispute = (disputeId: string, status: ProviderDispute["status"]): ProviderDispute => ({ disputeId, status, amountMinor: TOTAL, currency: "USD" });
const period = (paymentId: string, range = P1) =>
  ({ kind: "period", paymentId, subscriptionId: "sub_1", productId: PRO, ...range, credits: 2000, settledAt: range.serviceStart });
const topUp = (paymentId: string) => ({ kind: "top_up", paymentId, productId: TOP_UP, credits: 1000, settledAt: NOW });
/** "missing": the provider sent no usable lists. */
const fact = (decision: { paymentId: string }, adjustments: Adjustments | "missing" = { refunds: [], disputes: [] }, sessionId?: string) => ({
  paymentId: decision.paymentId, decision, currency: "USD", totalMinor: TOTAL, taxMinor: 0, ...(sessionId ? { sessionId } : {}),
  reversal: decideReversal({ totalMinor: TOTAL, currency: "USD", adjustments: adjustments === "missing" ? undefined : adjustments }),
});
const refunds = (...items: ProviderRefund[]): Adjustments => ({ refunds: items, disputes: [] });
const disputes = (...items: ProviderDispute[]): Adjustments => ({ refunds: [], disputes: items });
const sub = { subscriptionId: "sub_1", customerId: "cus_user_alice", productId: PRO, quantity: 1, status: "active", cancelAtNextBillingDate: false };

/** Claims and commits every claimed receipt, refunds and disputes included, with the facts of their payments. */
async function reconcile(t: T, customerRef: Ref, payments: ReturnType<typeof fact>[], subscriptions: object[] = []) {
  const claim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef }))!;
  const result = await t.mutation(internal.billingFulfill.commitReconciliation, {
    customerRef, fence: { generation: claim.generation, inputRevision: claim.inputRevision }, receiptRefs: claim.receipts.map(r => r.eventRef),
    payments: payments.filter(p => claim.receipts.some(r => r.paymentId === p.paymentId)) as never, subscriptions: subscriptions as never,
  });
  await t.mutation(internal.billingQueue.releaseCustomer, { customerRef, generation: claim.generation });
  return result;
}

const all = <N extends "billingGrants" | "billingPurchases" | "billingEvents" | "billingAdjustments" | "creditAccounts">(t: T, table: N) =>
  t.run(ctx => ctx.db.query(table).take(100));
const lots = async (t: T) => (await all(t, "billingGrants")).map(g => ({ kind: g.kind, revoked: g.revoked, consumed: g.consumed, exhausted: g.exhausted, fullyReversed: g.fullyReversed }));
const debt = async (t: T) => (await all(t, "creditAccounts"))[0]?.creditDebt ?? 0;
const states = async (t: T) => (await all(t, "billingEvents")).map(e => e.state);
const spend = (t: T, credits: number) => t.run(ctx => spendPaidCredits(ctx, "user_alice", mode, credits, Date.now()));
const paidPeriod = (t: T) => t.run(async ctx => isInPaidPeriod(await readPeriodLots(ctx, "user_alice", mode, Date.now()), Date.now()));

/** Alice with a settled, granted purchase for pay_1. */
async function settled(t: T, sku: "pro_monthly" | "top_up") {
  const alice = await customer(t);
  const purchaseRef = await checkout(t, alice, sku);
  await receive(t, alice, "payment.succeeded", "pay_1");
  const decision = sku === "pro_monthly" ? period("pay_1") : topUp("pay_1");
  expect(await reconcile(t, alice, [fact(decision, undefined, "cks_1")], sku === "pro_monthly" ? [sub] : [])).toBe("committed");
  return { alice, purchaseRef, decision };
}

describe("refunds", () => {
  test("a full refund of an unspent top-up revokes it, writes no debt and stops blocking grants", async () => {
    const t = setup();
    const { alice, purchaseRef, decision } = await settled(t, "top_up");
    await receive(t, alice, "refund.succeeded", "pay_1");
    expect(await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", TOTAL)))])).toBe("committed");
    expect(await lots(t)).toEqual([{ kind: "top_up", revoked: 1000, consumed: 0, exhausted: true, fullyReversed: true }]);
    expect(await debt(t)).toBe(0);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ reversedMinor: TOTAL, totalMinor: TOTAL, revokedCredits: 1000 });
    expect(await states(t)).toEqual(["processed", "processed"]);
    await checkout(t, alice, "top_up", 2);
    await receive(t, alice, "payment.succeeded", "pay_2");
    expect(await reconcile(t, alice, [fact(topUp("pay_2"), undefined, "cks_2")])).toBe("committed");
    expect(await all(t, "billingGrants")).toHaveLength(2);
    expect((await t.run(ctx => ctx.db.get("billingCustomers", alice)))?.unresolvedReceipts).toBe(0);
  });

  test("partial refunds revoke cumulatively, flooring once, and a replay writes nothing", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "top_up");
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", 333)))]);
    expect((await lots(t))[0].revoked).toBe(166);
    const second = refunds(refund("rfd_1", 333), refund("rfd_2", 334));
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, second)]);
    expect((await lots(t))[0].revoked).toBe(333);
    const before = JSON.stringify(await Promise.all((["billingGrants", "billingPurchases", "billingAdjustments", "creditAccounts"] as const).map(n => all(t, n))));
    // The same refunds found again (a webhook replay or a poll finding) never apply twice.
    await receive(t, alice, "refund.poll", "pay_1");
    vi.setSystemTime(NOW + 60_000);
    await reconcile(t, alice, [fact(decision, second)]);
    expect(JSON.stringify(await Promise.all((["billingGrants", "billingPurchases", "billingAdjustments", "creditAccounts"] as const).map(n => all(t, n))))).toBe(before);
    expect(await states(t)).toEqual(["processed", "processed", "processed", "processed"]);
  });

  test("a full refund after spending 1,500 period credits revokes 500, records 1,500 debt and ends the paid period", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "pro_monthly");
    expect(await spend(t, 1500)).toBe(0);
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", null, "succeeded", false)))], [sub]);
    expect(await lots(t)).toEqual([{ kind: "current_period", revoked: 500, consumed: 1500, exhausted: true, fullyReversed: true }]);
    expect(await debt(t)).toBe(1500);
    expect(await paidPeriod(t)).toBe(false);
    // The next grant pays the debt first (stage 7 offset).
    await checkout(t, alice, "top_up", 2);
    await receive(t, alice, "payment.succeeded", "pay_2");
    await reconcile(t, alice, [fact(topUp("pay_2"), undefined, "cks_2")]);
    expect((await all(t, "billingGrants"))[1]).toMatchObject({ kind: "top_up", debtOffset: 1000, exhausted: true });
    expect(await debt(t)).toBe(500);
  });

  test("a 50% refund of a period keeps the paid period", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "pro_monthly");
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", 1000)))], [sub]);
    expect(await lots(t)).toEqual([{ kind: "current_period", revoked: 1000, consumed: 0, exhausted: undefined, fullyReversed: undefined }]);
    expect(await paidPeriod(t)).toBe(true);
  });

  test("a refund of a period that rolled over revokes the rollover first and never the carried credits twice", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "pro_monthly");
    await spend(t, 1400);
    vi.setSystemTime(P1.serviceEnd + 60_000);
    await receive(t, alice, "payment.succeeded", "pay_2");
    await reconcile(t, alice, [fact(period("pay_2", P2))], [sub]);
    expect((await lots(t)).map(l => l.kind)).toEqual(["current_period", "current_period", "rollover"]);
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", TOTAL)))], [sub]);
    const [first, renewal, rollover] = await all(t, "billingGrants");
    expect([first.revoked, first.transferred, renewal.revoked, rollover.quantity, rollover.revoked]).toEqual([0, 600, 0, 600, 600]);
    expect(await debt(t)).toBe(1400);
  });

  test("an expired period lot's unspent credits are revoked, so only the spent part becomes debt", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "pro_monthly");
    await spend(t, 1600);
    vi.setSystemTime(P1.serviceEnd + 5 * 24 * 60 * 60_000);
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", TOTAL)))], [sub]);
    expect((await lots(t))[0]).toMatchObject({ revoked: 400, consumed: 1600 });
    expect(await debt(t)).toBe(1600);
  });

  test.each([["in the same claim"], ["before the payment receipt"]])("a refund read %s grants and revokes in one commit", async when => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice, "pro_monthly");
    if (when === "in the same claim") await receive(t, alice, "payment.succeeded", "pay_1");
    await receive(t, alice, "refund.succeeded", "pay_1");
    const refunded = fact(period("pay_1"), refunds(refund("rfd_1", TOTAL)), "cks_1");
    expect(await reconcile(t, alice, [refunded], [sub])).toBe("committed");
    expect(await lots(t)).toEqual([{ kind: "current_period", revoked: 2000, consumed: 0, exhausted: true, fullyReversed: true }]);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ state: "settled", revokedCredits: 2000 });
    expect(await states(t)).toEqual(when === "in the same claim" ? ["processed", "processed"] : ["processed"]);
    if (when === "before the payment receipt") {
      await receive(t, alice, "payment.succeeded", "pay_1");
      await reconcile(t, alice, [refunded], [sub]);
      expect(await lots(t)).toEqual([{ kind: "current_period", revoked: 2000, consumed: 0, exhausted: true, fullyReversed: true }]);
    }
  });

  test("a refund settling with a server-created renewal finds the new purchase by re-read", async () => {
    const t = setup();
    const { alice } = await settled(t, "pro_monthly");
    await receive(t, alice, "refund.succeeded", "pay_2");
    await reconcile(t, alice, [fact(period("pay_2", P2), refunds(refund("rfd_2", 1000)))], [sub]);
    const renewal = (await all(t, "billingPurchases")).find(p => p.intentId === "renewal:pay_2");
    expect(renewal).toMatchObject({ state: "settled", reversedMinor: 1000, revokedCredits: 1000 });
  });

  test("an early renewal's unstarted period lot is never spent, and its refund still revokes it", async () => {
    const t = setup();
    const { alice } = await settled(t, "pro_monthly");
    await receive(t, alice, "payment.succeeded", "pay_2");
    await reconcile(t, alice, [fact(period("pay_2", P2))], [sub]); // settles in P1, before P2 starts
    expect(await spend(t, 2500)).toBe(500); // the rolled-over 2000, never P2's lot
    await receive(t, alice, "refund.succeeded", "pay_2");
    await reconcile(t, alice, [fact(period("pay_2", P2), refunds(refund("rfd_2", TOTAL)))], [sub]);
    const renewal = (await all(t, "billingGrants")).find(g => g.serviceStart === P2.serviceStart);
    expect(renewal).toMatchObject({ consumed: 0, revoked: 2000, exhausted: true, fullyReversed: true });
    expect(await debt(t)).toBe(0);
  });

  test("a refund and a lost dispute of the same money are capped at the total", async () => {
    const t = setup();
    const { alice, purchaseRef, decision } = await settled(t, "top_up");
    await receive(t, alice, "dispute.lost", "pay_1");
    await reconcile(t, alice, [fact(decision, { refunds: [refund("rfd_1", TOTAL)], disputes: [dispute("dsp_1", "lost")] })]);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ reversedMinor: TOTAL, revokedCredits: 1000 });
    expect(await debt(t)).toBe(0);
  });

  test("a failed refund reverses nothing, and a counted refund later shown failed stays counted", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "top_up");
    await receive(t, alice, "refund.failed", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_0", 500, "failed")))]);
    expect((await lots(t))[0].revoked).toBe(0);
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_0", 500, "failed"), refund("rfd_1", 1000)))]);
    await receive(t, alice, "refund.failed", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_0", 500, "failed"), refund("rfd_1", 1000, "failed")))]);
    expect((await lots(t))[0].revoked).toBe(500);
    expect((await all(t, "billingAdjustments")).map(a => [a.providerId, a.status, a.countedMinor])).toEqual([["rfd_0", "failed", 0], ["rfd_1", "failed", 1000]]);
    expect(logged("[billingReversals] counted adjustment no longer counts")).toBe(true);
    expect(await states(t)).toEqual(["processed", "processed", "processed", "processed"]);
  });

  test.each([
    ["a missing list", "missing" as const],
    ["another currency", refunds({ ...refund("rfd_1", 1000), currency: "EUR" })],
    ["a partial refund without an amount", refunds(refund("rfd_1", null, "succeeded", true))],
  ])("an unknown reversal (%s) leaves the refund pending and the payment ungranted", async (_name, adjustments) => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice, "top_up");
    await receive(t, alice, "payment.succeeded", "pay_1");
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(topUp("pay_1"), adjustments, "cks_1")]);
    expect(await states(t)).toEqual(["pending", "pending"]);
    expect(await all(t, "billingGrants")).toEqual([]);
    expect(await all(t, "billingAdjustments")).toEqual([]);
  });

  test("a refund of another customer's payment is quarantined and writes nothing of theirs", async () => {
    const t = setup();
    const { alice, purchaseRef } = await settled(t, "top_up");
    const bob = await customer(t, "user_bob");
    await receive(t, bob, "refund.succeeded", "pay_1");
    const mismatch = { ...fact({ kind: "quarantine", paymentId: "pay_1", reason: "customer_mismatch" } as never, refunds(refund("rfd_1", TOTAL))) };
    await reconcile(t, bob, [mismatch]);
    expect((await all(t, "billingEvents")).map(e => [e.customerRef, e.state, e.quarantineReason])).toEqual([
      [alice, "processed", undefined], [bob, "quarantined", "unsupported"],
    ]);
    expect(await all(t, "billingAdjustments")).toEqual([]);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).not.toHaveProperty("revokedCredits");
    expect((await lots(t))[0].revoked).toBe(0);
  });

  test("a deleted owner's lots are revoked but no debt is written, and it is logged", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "pro_monthly");
    await spend(t, 1500);
    await t.run(async ctx => {
      const user = (await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", "user_alice")).unique())!;
      await ctx.db.patch("users", user._id, { deletedAt: NOW });
    });
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, refunds(refund("rfd_1", TOTAL)))], [sub]);
    expect((await lots(t))[0]).toMatchObject({ revoked: 500, fullyReversed: true });
    expect(await debt(t)).toBe(0);
    expect(logged("[billingReversals] reversal debt not recorded")).toBe(true);
  });
});

describe("disputes", () => {
  const held = (t: T, ref: Ref) => t.run(ctx => hasActiveHold(ctx, ref));

  test("holds per dispute: refuses checkout, still grants a renewal, expired keeps it, lost reverses and releases", async () => {
    const t = setup();
    const { alice, purchaseRef, decision } = await settled(t, "pro_monthly");
    await receive(t, alice, "dispute.opened", "pay_1");
    await reconcile(t, alice, [fact(decision, disputes(dispute("dsp_1", "opened")))], [sub]);
    expect(await held(t, alice)).toBe(true);
    await expect(checkout(t, alice, "top_up", 2)).rejects.toThrow("FORBIDDEN");
    await receive(t, alice, "payment.succeeded", "pay_2");
    expect(await reconcile(t, alice, [fact(period("pay_2", P2))], [sub])).toBe("committed");
    expect((await lots(t)).filter(l => l.kind === "current_period")).toHaveLength(2);

    const step = async (...items: ProviderDispute[]) => {
      await receive(t, alice, "dispute.poll", "pay_1");
      await reconcile(t, alice, [fact(decision, disputes(...items))], [sub]);
      return await held(t, alice);
    };
    expect(await step(dispute("dsp_1", "won"), dispute("dsp_2", "opened"))).toBe(true);
    expect(await step(dispute("dsp_1", "won"), dispute("dsp_2", "expired"))).toBe(true);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).not.toHaveProperty("revokedCredits");
    expect(await step(dispute("dsp_1", "won"), dispute("dsp_2", "lost"))).toBe(false);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ reversedMinor: TOTAL, revokedCredits: 2000 });
    expect((await all(t, "billingAdjustments")).map(a => [a.providerId, a.status, a.holdActive, a.countedMinor])).toEqual([
      ["dsp_1", "won", false, 0], ["dsp_2", "lost", false, TOTAL],
    ]);
    expect((await all(t, "billingEvents")).every(e => e.state === "processed")).toBe(true);
  });

  test("a won dispute releases its hold and restores nothing", async () => {
    const t = setup();
    const { alice, decision } = await settled(t, "top_up");
    await receive(t, alice, "refund.succeeded", "pay_1");
    await reconcile(t, alice, [fact(decision, { refunds: [refund("rfd_1", 1000)], disputes: [dispute("dsp_1", "challenged")] })]);
    expect(await held(t, alice)).toBe(true);
    await receive(t, alice, "dispute.won", "pay_1");
    await reconcile(t, alice, [fact(decision, { refunds: [refund("rfd_1", 1000)], disputes: [dispute("dsp_1", "won")] })]);
    expect(await held(t, alice)).toBe(false);
    expect((await lots(t))[0].revoked).toBe(500);
  });
});

describe("deferred settlement after a resolved negative", () => {
  const failed = (paymentId: string) => fact({ kind: "no_grant", paymentId, reason: "failed" } as never);
  const reads = async (t: T) => (await all(t, "billingEvents")).filter(e => e.eventType === "payment.reconcile");

  test("a refund resolved while its payment waits on another negative queues one read that later grants the net once", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice, "top_up");
    await receive(t, alice, "refund.succeeded", "pay_q"); // its read fails in the first claim: no fact
    await receive(t, alice, "refund.succeeded", "pay_1"); // the only receipt naming pay_1
    const p1 = fact(topUp("pay_1"), refunds(refund("rfd_1", 1000)), "cks_1");
    expect(await reconcile(t, alice, [p1])).toBe("blocked");
    expect(await all(t, "billingGrants")).toEqual([]);
    expect((await all(t, "billingEvents")).map(e => [e.paymentId, e.eventType, e.state])).toEqual([
      ["pay_q", "refund.succeeded", "pending"], ["pay_1", "refund.succeeded", "processed"], ["pay_1", "payment.reconcile", "pending"],
    ]);
    // Session-only purchase: nothing bound yet, the reversal waits in its adjustment row.
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ state: "preparing" });
    expect((await t.run(ctx => ctx.db.get("billingCustomers", alice)))?.unresolvedReceipts).toBe(2);

    // Still fenced on a retry: the queued read backs off, and no second one is added.
    vi.setSystemTime(NOW + 5 * 60_000);
    expect(await reconcile(t, alice, [p1])).toBe("blocked");
    expect(await reads(t)).toHaveLength(1);

    vi.setSystemTime(NOW + 30 * 60_000);
    expect(await reconcile(t, alice, [p1, failed("pay_q")])).toBe("committed");
    expect(await lots(t)).toEqual([{ kind: "top_up", revoked: 500, consumed: 0, exhausted: undefined, fullyReversed: undefined }]);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ state: "settled", paymentId: "pay_1", revokedCredits: 500 });
    const after = (await t.run(ctx => ctx.db.get("billingCustomers", alice)))!;
    expect([after.unresolvedReceipts, after.pendingPurchaseRef]).toEqual([0, undefined]);
    expect(await states(t)).toEqual(["processed", "processed", "processed"]);

    // A later replay of the payment grants nothing more and queues nothing.
    await receive(t, alice, "payment.succeeded", "pay_1");
    vi.setSystemTime(NOW + 60 * 60_000);
    expect(await reconcile(t, alice, [p1])).toBe("committed");
    expect(await lots(t)).toEqual([{ kind: "top_up", revoked: 500, consumed: 0, exhausted: undefined, fullyReversed: undefined }]);
    expect(await reads(t)).toHaveLength(1);
  });

  test("no read is queued while a positive receipt for the payment is still pending", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice, "top_up");
    await receive(t, alice, "refund.succeeded", "pay_q");
    await receive(t, alice, "payment.succeeded", "pay_1");
    await receive(t, alice, "refund.succeeded", "pay_1");
    expect(await reconcile(t, alice, [fact(topUp("pay_1"), refunds(refund("rfd_1", 1000)), "cks_1")])).toBe("blocked");
    expect(await states(t)).toEqual(["pending", "pending", "processed"]);
    expect(await reads(t)).toEqual([]);
  });
});

describe("grant fence", () => {
  test("an unresolved refund of a payment not in this commit still blocks grants", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice, "top_up");
    await receive(t, alice, "payment.succeeded", "pay_1");
    // Its payment read failed, so the commit has no fact for it.
    await receive(t, alice, "refund.succeeded", "pay_other");
    expect(await reconcile(t, alice, [fact(topUp("pay_1"), undefined, "cks_1")])).toBe("blocked");
    expect(await all(t, "billingGrants")).toEqual([]);
  });

  test("a quarantined unsupported positive does not block a later grant", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice, "top_up");
    const stuck = await receive(t, alice, "payment.succeeded", "pay_0");
    await t.run(ctx => ctx.db.patch("billingEvents", stuck, { state: "quarantined", quarantineReason: "unsupported" }));
    await receive(t, alice, "payment.succeeded", "pay_1");
    expect(await reconcile(t, alice, [fact(topUp("pay_1"), undefined, "cks_1")])).toBe("committed");
    expect(await all(t, "billingGrants")).toHaveLength(1);
  });
});
