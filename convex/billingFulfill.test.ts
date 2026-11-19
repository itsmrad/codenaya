// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { currentFreeAllocation, freeRemaining } from "../src/features/billing/free-allocation";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_PROVIDER_READS_PER_CLAIM } from "./billingReconcile";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 10, 12);
const P1 = { serviceStart: Date.UTC(2026, 10, 1), serviceEnd: Date.UTC(2026, 11, 1) };
const P2 = { serviceStart: P1.serviceEnd, serviceEnd: Date.UTC(2027, 0, 1) };
const DIGEST = "a".repeat(64);
const INTERNAL_KEY = "test-internal-key";
const PRO = "pdt_pro";
const TOP_UP = "pdt_topup";
type Mode = "test_mode" | "live_mode";
type Facts = { payments?: PaymentFact[]; subscriptions?: SubscriptionFact[] };
type PaymentFact = { paymentId: string; decision: Record<string, unknown> & { kind: string; paymentId: string }; sessionId?: string; currency?: string; totalMinor?: number; taxMinor?: number };
type SubscriptionFact = Record<string, unknown> & { subscriptionId: string };

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function customer(t: T, userId = "user_alice", mode: Mode = "test_mode") {
  await t.run(async ctx => {
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique();
    if (!user) await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
  });
  const customerRef = await t.mutation(internal.billing.ensureCustomer, { mode, userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}` });
  await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: `cus_${userId}` });
  return customerRef;
}

/** A checkout for `sku` bound to its session (and Pro to `sub_1`), as checkout will leave it. */
async function checkout(t: T, customerRef: Id<"billingCustomers">, sku: "pro_monthly" | "top_up" = "pro_monthly", n = 1) {
  const pro = sku === "pro_monthly";
  const mode = (await t.run(ctx => ctx.db.get("billingCustomers", customerRef)))!.mode;
  const purchaseRef = await t.mutation(internal.billing.reservePurchase, {
    customerRef, intentId: `intent_${n}`,
    terms: { sku, catalogVersion: "2026-11-17", productId: pro ? PRO : TOP_UP, quantity: 1, credits: pro ? 2000 : 1000 },
  });
  if (pro) await t.mutation(internal.billing.bindSubscription, { customerRef, mode, subscriptionId: "sub_1", productId: PRO });
  await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, sessionId: `cks_${n}`, ...(pro ? { subscriptionId: "sub_1" } : {}) });
  return purchaseRef;
}

let webhookSeq = 0;
const receive = (t: T, customerRef: Id<"billingCustomers"> | undefined, eventType: string, ids: { paymentId?: string; subscriptionId?: string; sessionId?: string }, mode: Mode = "test_mode") =>
  t.mutation(internal.billing.recordReceipt, { customerRef, mode, webhookId: `wh_${++webhookSeq}`, eventType, bodyDigest: DIGEST, occurredAt: 1, ...ids });

const period = (paymentId: string, range = P1, subscriptionId = "sub_1") =>
  ({ kind: "period", paymentId, subscriptionId, productId: PRO, ...range, credits: 2000, settledAt: range.serviceStart });
const topUp = (paymentId: string) => ({ kind: "top_up", paymentId, productId: TOP_UP, credits: 1000, settledAt: NOW });
const paid = (decision: PaymentFact["decision"], extra: Partial<PaymentFact> = {}): PaymentFact =>
  ({ paymentId: decision.paymentId, decision, currency: "USD", totalMinor: 2000, taxMinor: 180, ...extra });
const sub = (extra: Record<string, unknown> = {}, userId = "user_alice"): SubscriptionFact => ({
  subscriptionId: "sub_1", customerId: `cus_${userId}`, productId: PRO, quantity: 1, status: "active",
  nextBillingAt: P1.serviceEnd, cancelAtNextBillingDate: false, ...extra,
});

/** Claims the customer and commits `facts` for every claimed receipt except refunds and disputes, as the reconciler does. */
async function reconcile(t: T, customerRef: Id<"billingCustomers">, facts: Facts) {
  const claim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef }))!;
  const result = await t.mutation(internal.billingFulfill.commitReconciliation, {
    customerRef, fence: { generation: claim.generation, inputRevision: claim.inputRevision },
    receiptRefs: claim.receipts.filter(r => !/^(refund|dispute)\./.test(r.eventType)).map(r => r.eventRef),
    payments: (facts.payments ?? []) as never, subscriptions: (facts.subscriptions ?? []) as never,
  });
  await t.mutation(internal.billingQueue.releaseCustomer, { customerRef, generation: claim.generation });
  return result;
}

const rows = <N extends "billingGrants" | "billingPurchases" | "billingEvents" | "billingSubscriptions" | "creditAccounts" | "billingCustomers">(t: T, table: N) =>
  t.run(ctx => ctx.db.query(table).take(100));
const grants = async (t: T) => (await rows(t, "billingGrants")).map(g => [g.kind, g.sourceKey, g.quantity, g.expiresAt]);
const read = <N extends "billingCustomers" | "billingPurchases" | "billingEvents">(t: T, id: Id<N>) => t.run(ctx => ctx.db.get(id));
const account = async (t: T) => (await rows(t, "creditAccounts"))[0] ?? null;
const snapshot = async (t: T) => JSON.stringify(await Promise.all(
  (["billingGrants", "billingPurchases", "billingEvents", "billingSubscriptions", "creditAccounts", "billingCustomers"] as const).map(name => rows(t, name)),
));

describe("settlement", () => {
  test.each([["payment first"], ["renewal first"]])("one period from payment.succeeded and subscription.renewed, %s, with redeliveries, grants once", async order => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice);
    const payment = () => receive(t, alice, "payment.succeeded", { paymentId: "pay_1", subscriptionId: "sub_1" });
    const renewal = () => receive(t, alice, "subscription.renewed", { paymentId: "pay_1", subscriptionId: "sub_1" });
    const facts = { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] };
    await (order === "payment first" ? payment() : renewal());
    expect(await reconcile(t, alice, facts)).toBe("committed");
    await (order === "payment first" ? renewal() : payment());
    await payment();
    vi.setSystemTime(NOW + 10 * 60_000);
    expect(await reconcile(t, alice, facts)).toBe("committed");
    expect(await grants(t)).toEqual([["current_period", `period:sub_1:${P1.serviceStart}:${P1.serviceEnd}`, 2000, P1.serviceEnd]]);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", paymentId: "pay_1", currency: "USD", principalMinor: 1820 });
    expect((await rows(t, "billingEvents")).map(e => e.state)).toEqual(["processed", "processed", "processed"]);
    const after = await read(t, alice);
    expect(after).toMatchObject({ unresolvedReceipts: 0 });
    expect(after?.pendingPurchaseRef).toBeUndefined();
    expect((await rows(t, "billingSubscriptions"))[0]).toMatchObject({ status: "active", paidThrough: P1.serviceEnd, ...P1 });
  });

  test("a renewal one minute after the period ends grants a new period and a capped rollover", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] });
    vi.setSystemTime(P1.serviceEnd + 60_000);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_2" });
    expect(await reconcile(t, alice, { payments: [paid(period("pay_2", P2))], subscriptions: [sub()] })).toBe("committed");
    expect(await grants(t)).toEqual([
      ["current_period", `period:sub_1:${P1.serviceStart}:${P1.serviceEnd}`, 2000, P1.serviceEnd],
      ["current_period", `period:sub_1:${P2.serviceStart}:${P2.serviceEnd}`, 2000, P2.serviceEnd],
      ["rollover", `rollover:period:sub_1:${P1.serviceStart}:${P1.serviceEnd}`, 2000, P2.serviceEnd],
    ]);
    expect((await rows(t, "billingPurchases")).map(p => [p.intentId, p.state])).toEqual([["intent_1", "settled"], ["renewal:pay_2", "settled"]]);
  });

  test("a missed period applied late is never spendable and creates no rollover", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] });
    vi.setSystemTime(P2.serviceEnd + DAY);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_2" });
    expect(await reconcile(t, alice, { payments: [paid(period("pay_2", P2))], subscriptions: [sub()] })).toBe("committed");
    const all = await grants(t);
    expect(all.map(g => g[0])).toEqual(["current_period", "current_period"]);
    expect(all[1][3]).toBeLessThan(Date.now());
  });

  test("a settled purchase re-read with another service period grants nothing new", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] });
    await receive(t, alice, "subscription.renewed", { paymentId: "pay_1", subscriptionId: "sub_1" });
    vi.setSystemTime(NOW + 10 * 60_000);
    const shifted = { serviceStart: P1.serviceStart + DAY, serviceEnd: P1.serviceEnd + DAY };
    expect(await reconcile(t, alice, { payments: [paid(period("pay_1", shifted))], subscriptions: [sub()] })).toBe("committed");
    expect(await grants(t)).toHaveLength(1);
  });
});

describe("fence", () => {
  test("a stale generation or revision, or a foreign or settled receipt ref, is stale with zero writes", async () => {
    const t = setup();
    const alice = await customer(t);
    const bob = await customer(t, "user_bob");
    await checkout(t, alice);
    const own = await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    const bobs = await receive(t, bob, "payment.succeeded", { paymentId: "pay_bob" });
    const claim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef: alice }))!;
    const fence = { generation: claim.generation, inputRevision: claim.inputRevision };
    const commit = (over: { fence?: typeof fence; receiptRefs?: Id<"billingEvents">[] }) => t.mutation(internal.billingFulfill.commitReconciliation, {
      customerRef: alice, fence, receiptRefs: [own], payments: [paid(period("pay_1"), { sessionId: "cks_1" })] as never, subscriptions: [sub()] as never, ...over,
    });
    const before = await snapshot(t);
    expect(await commit({ fence: { ...fence, generation: fence.generation - 1 } })).toBe("stale");
    expect(await commit({ receiptRefs: [own, bobs] })).toBe("stale");
    expect(await snapshot(t)).toBe(before);
    await t.run(ctx => ctx.db.patch("billingEvents", own, { state: "processed" }));
    expect(await commit({})).toBe("stale");
    await t.run(ctx => ctx.db.patch("billingEvents", own, { state: "pending" }));
    await receive(t, alice, "subscription.updated", { subscriptionId: "sub_1" });
    const mid = await snapshot(t);
    expect(await commit({})).toBe("stale");
    expect(await snapshot(t)).toBe(mid);
    expect(await grants(t)).toEqual([]);
  });

  test("a pending refund blocks the grant while the same commit applies the cancellation and marks its receipt", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice);
    const payment = await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    const cancelled = await receive(t, alice, "subscription.cancelled", { subscriptionId: "sub_1" });
    const refund = await receive(t, alice, "refund.succeeded", { paymentId: "pay_1" });
    const result = await reconcile(t, alice, {
      payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub({ status: "cancelled" })],
    });
    expect(result).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "preparing" });
    expect((await rows(t, "billingSubscriptions"))[0]).toMatchObject({ status: "cancelled" });
    expect([(await read(t, payment))?.state, (await read(t, cancelled))?.state, (await read(t, refund))?.state]).toEqual(["pending", "processed", "pending"]);
    expect(await read(t, alice)).toMatchObject({ unresolvedReceipts: 2 });
    expect(await account(t)).toBeNull();
  });

  test("an unmapped quarantined refund for the payment blocks it, so it is never spendable", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, undefined, "refund.succeeded", { paymentId: "pay_1" });
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    expect(await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] })).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect(await account(t)).toBeNull();
  });

  test("a backlog commits non-positive outcomes first, then grants exactly once on a later claim", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    for (let i = 0; i < 29; i++) await receive(t, alice, "subscription.updated", { subscriptionId: "sub_1" });
    const facts = { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] };
    expect(await reconcile(t, alice, facts)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect(await read(t, alice)).toMatchObject({ unresolvedReceipts: 6 });
    vi.setSystemTime(NOW + 5 * 60_000);
    expect(await reconcile(t, alice, facts)).toBe("committed");
    expect(await grants(t)).toHaveLength(1);
    expect(await read(t, alice)).toMatchObject({ unresolvedReceipts: 0 });
    expect((await rows(t, "billingEvents")).every(e => e.state === "processed")).toBe(true);
  });
});

describe("excluded payments", () => {
  test.each([
    ["usage or proration", { kind: "no_grant", paymentId: "pay_1", reason: "not_full_period" }, "preparing", "processed"],
    ["zero amount", { kind: "quarantine", paymentId: "pay_1", reason: "amount" }, "quarantined", "processed"],
    ["missing period", { kind: "pending", paymentId: "pay_1", reason: "service_period_unknown" }, "preparing", "pending"],
  ])("%s grants nothing", async (_name, decision, purchaseState, receiptState) => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice);
    const eventRef = await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    expect(await reconcile(t, alice, { payments: [paid(decision, { sessionId: "cks_1" })], subscriptions: [sub()] })).toBe("committed");
    expect(await grants(t)).toEqual([]);
    expect(await account(t)).toBeNull();
    expect(await read(t, purchaseRef)).toMatchObject({ state: purchaseState });
    expect(await read(t, eventRef)).toMatchObject({ state: receiptState });
  });

  test("processing, then succeeded, grants once", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice, "top_up");
    await receive(t, alice, "payment.processing", { paymentId: "pay_1" });
    await reconcile(t, alice, { payments: [paid({ kind: "processing", paymentId: "pay_1" }, { sessionId: "cks_1" })] });
    expect(await read(t, purchaseRef)).toMatchObject({ state: "processing", paymentId: "pay_1" });
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    vi.setSystemTime(NOW + 5 * 60_000);
    expect(await reconcile(t, alice, { payments: [paid(topUp("pay_1"))] })).toBe("committed");
    expect(await grants(t)).toEqual([["top_up", "top_up:pay_1:0", 1000, Date.UTC(2027, 10, 10, 12)]]);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled" });
  });
});

describe("records", () => {
  test("a second subscription, a duplicate period payment and a top-up with no intent are quarantined without rolling back the batch", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] });
    await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode: "test_mode", subscriptionId: "sub_2", productId: PRO });
    for (const paymentId of ["pay_2", "pay_3", "pay_4"]) await receive(t, alice, "payment.succeeded", { paymentId });
    const cancel = await receive(t, alice, "subscription.cancelled", { subscriptionId: "sub_2" });
    vi.setSystemTime(NOW + 5 * 60_000);
    const result = await reconcile(t, alice, {
      payments: [paid(period("pay_2", P1, "sub_2")), paid(period("pay_3")), paid(topUp("pay_4"))],
      subscriptions: [sub({ subscriptionId: "sub_2", status: "cancelled" })],
    });
    expect(result).toBe("committed");
    expect(await grants(t)).toHaveLength(1);
    expect((await rows(t, "billingPurchases")).map(p => [p.intentId, p.state])).toEqual([
      ["intent_1", "settled"], ["renewal:pay_2", "quarantined"], ["renewal:pay_3", "quarantined"], ["unmatched:pay_4", "quarantined"],
    ]);
    expect(await read(t, cancel)).toMatchObject({ state: "processed" });
    expect(await read(t, alice)).toMatchObject({ unresolvedReceipts: 0 });
  });

  test("a deleted owner gets no grant or credit account, and its purchase needs cancellation recovery", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice);
    await t.run(async ctx => {
      const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", "user_alice")).unique();
      await ctx.db.patch("users", user!._id, { deletedAt: NOW });
    });
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    expect(await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] })).toBe("committed");
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", cancellationRecoveryRequired: true });
    expect(await grants(t)).toEqual([]);
    expect(await account(t)).toBeNull();
  });

  test("a held owner's positives are blocked while its cancellation still applies", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await t.run(ctx => ctx.db.patch("billingCustomers", alice, { hold: true }));
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    const cancel = await receive(t, alice, "subscription.cancelled", { subscriptionId: "sub_1" });
    const result = await reconcile(t, alice, {
      payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub({ status: "cancelled", cancelAtNextBillingDate: true })],
    });
    expect(result).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect((await rows(t, "billingSubscriptions"))[0]).toMatchObject({ status: "cancelled", cancelAt: P1.serviceEnd });
    expect(await read(t, cancel)).toMatchObject({ state: "processed" });
  });

  test("paidThrough never shrinks on an old read, and the plan is unchanged", async () => {
    const t = setup();
    const alice = await customer(t);
    await checkout(t, alice);
    await t.run(ctx => ctx.db.insert("creditAccounts", { userId: "user_alice", plan: "free", periodStartsAt: Date.UTC(2026, 10, 1), periodUsed: 0, dayStartsAt: Date.UTC(2026, 10, 10), dayUsed: 0 }));
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_2" });
    await reconcile(t, alice, { payments: [paid(period("pay_2", P2), { sessionId: "cks_1" })], subscriptions: [sub()] });
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    vi.setSystemTime(NOW + 5 * 60_000);
    await reconcile(t, alice, { payments: [paid(period("pay_1"))], subscriptions: [sub()] });
    expect(await grants(t)).toHaveLength(2);
    expect((await rows(t, "billingSubscriptions"))[0]).toMatchObject({ status: "active", paidThrough: P2.serviceEnd, ...P2 });
    expect(await account(t)).toMatchObject({ plan: "free", paidCreditsVersion: 1, paidCreditsMode: "test_mode" });
  });
});

describe("account enablement", () => {
  const seedMessage = (t: T) => t.run(async ctx => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: "user_alice", updatedAt: 1 });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 1 });
    return await ctx.db.insert("messages", {
      conversationId, projectId, role: "assistant", content: "", status: "processing", runModel: { modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    });
  });
  /** A platform run whose running cost is `costUsd`: 150 credits per dollar. */
  const charge = (t: T, messageId: Id<"messages">, costUsd: number) => t.mutation(api.credits.recordRunUsage, {
    internalKey: INTERNAL_KEY, messageId, source: "platform", inputTokens: 1000, outputTokens: 100, costUsd,
  });
  const legacy = (t: T, periodUsed: number, extra: Record<string, unknown> = {}) => t.run(ctx => ctx.db.insert("creditAccounts", {
    userId: "user_alice", plan: "free", periodStartsAt: Date.UTC(2026, 10, 1), periodUsed, dayStartsAt: Date.UTC(2026, 10, 10), dayUsed: 0, ...extra,
  }));
  const settlePro = async (t: T, range = P1) => {
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    expect(await reconcile(t, alice, { payments: [paid(period("pay_1", range), { sessionId: "cks_1" })], subscriptions: [sub()] })).toBe("committed");
  };

  test("creates the account with both fields and no prior run, and the next charge spends the lot", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
    const t = setup();
    await settlePro(t);
    expect(await account(t)).toMatchObject({ plan: "free", paidCreditsVersion: 1, paidCreditsMode: "test_mode", periodUsed: 0, freeUsed: 0 });
    await charge(t, await seedMessage(t), 1);
    expect((await rows(t, "billingGrants"))[0]).toMatchObject({ consumed: 150 });
  });

  test("an existing 300 debt is offset by the new grant", async () => {
    const t = setup();
    await legacy(t, 0, { paidCreditsVersion: 1, paidCreditsMode: "test_mode", creditDebt: 300 });
    await settlePro(t);
    expect((await rows(t, "billingGrants"))[0]).toMatchObject({ debtOffset: 300 });
    expect(await account(t)).toMatchObject({ creditDebt: 0 });
  });

  test("an account enabled in the other mode keeps positives blocked", async () => {
    const t = setup();
    await legacy(t, 0, { paidCreditsVersion: 1, paidCreditsMode: "live_mode" });
    const alice = await customer(t);
    await checkout(t, alice);
    await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    expect(await reconcile(t, alice, { payments: [paid(period("pay_1"), { sessionId: "cks_1" })], subscriptions: [sub()] })).toBe("blocked");
    expect(await grants(t)).toEqual([]);
  });

  test("enabling after 120 legacy Free credits leaves 180 Free this month", async () => {
    const t = setup();
    await legacy(t, 120);
    await settlePro(t);
    const stored = (await account(t))!;
    expect(stored).toMatchObject({ freeMonthStartsAt: Date.UTC(2026, 10, 1), freeUsed: 120 });
    expect(freeRemaining(currentFreeAllocation(stored, 0, Date.now()).allocation)).toBe(180);
  });

  test("paid usage in a period that ends mid-month never counts against that month's Free", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
    const t = setup();
    await legacy(t, 50);
    const midMonth = { serviceStart: Date.UTC(2026, 9, 20), serviceEnd: Date.UTC(2026, 10, 20) };
    await settlePro(t, midMonth);
    const messageId = await seedMessage(t);
    await charge(t, messageId, 10); // 1,500 credits from the period lot
    vi.setSystemTime(Date.UTC(2026, 10, 21));
    await charge(t, messageId, 10.1); // 15 more, past the period's end
    const stored = (await account(t))!;
    expect(stored).toMatchObject({ freeMonthStartsAt: Date.UTC(2026, 10, 1), freeUsed: 65, creditDebt: 0 });
    expect(freeRemaining(currentFreeAllocation(stored, 0, Date.now()).allocation)).toBe(235);
  });
});

describe("reconcileClaim", () => {
  const ENV = {
    CODENAYA_DEPLOYMENT: "development", DODO_PAYMENTS_ENVIRONMENT: "test_mode", DODO_PAYMENTS_BUSINESS_ID: "bus_synthetic",
    DODO_PAYMENTS_API_KEY: "sk_synthetic", DODO_PAYMENTS_PRO_PRODUCT_ID: PRO, DODO_PAYMENTS_TOP_UP_PRODUCT_ID: TOP_UP,
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const paymentBody = (paymentId: string, extra: Record<string, unknown> = {}) => ({
    payment_id: paymentId, business_id: "bus_synthetic", status: "succeeded", customer: { customer_id: "cus_user_alice" },
    subscription_id: "sub_1", product_cart: null, total_amount: 2000, tax: 180, currency: "USD", created_at: iso(NOW - DAY),
    charge_type: "new", service_periods: [{ subscription_id: "sub_1", starts_at: iso(P1.serviceStart), ends_at: iso(P1.serviceEnd), proration_factor: "1" }],
    ...extra,
  });
  const subscriptionBody = {
    subscription_id: "sub_1", status: "active", product_id: PRO, customer: { customer_id: "cus_user_alice" }, quantity: 1,
    previous_billing_date: iso(P1.serviceStart), next_billing_date: iso(P1.serviceEnd), cancel_at_next_billing_date: false,
  };
  /** Answers each Dodo path from `bodies`, or with `status`. */
  const stubFetch = (bodies: (path: string) => unknown, status = 200) => {
    const fetchMock = vi.fn(async (url: string) => {
      const body = status === 200 ? bodies(new URL(url).pathname) : { error: "synthetic" };
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const withEnv = (extra: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries({ ...ENV, ...extra })) vi.stubEnv(name, value);
  };
  const run = (t: T, customerRef: Id<"billingCustomers">) => t.action(internal.billingQueue.processCustomer, { customerRef });

  test("reads the provider and grants a settled Pro payment end to end", async () => {
    withEnv();
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await checkout(t, alice);
    const fetchMock = stubFetch(path => path.startsWith("/payments/") ? paymentBody("pay_1", { checkout_session_id: "cks_1" }) : subscriptionBody);
    const eventRef = await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    await run(t, alice);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://test.dodopayments.com/payments/pay_1", "https://test.dodopayments.com/subscriptions/sub_1"]);
    expect(await grants(t)).toHaveLength(1);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", paymentId: "pay_1" });
    expect(await read(t, eventRef)).toMatchObject({ state: "processed" });
  });

  test.each([
    ["a placeholder API key", { DODO_PAYMENTS_API_KEY: "PLACEHOLDER_KEY" }, "test_mode"],
    ["a config mode other than the claim's", {}, "live_mode"],
  ] as const)("%s makes no provider call and leaves receipts pending", async (_name, env, mode) => {
    withEnv(env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    const ref = await customer(t, "user_alice", mode);
    const fetchMock = stubFetch(() => ({}));
    const eventRef = await receive(t, ref, "payment.succeeded", { paymentId: "pay_1" }, mode);
    await run(t, ref);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await read(t, eventRef)).toMatchObject({ state: "pending", attempts: 1 });
  });

  test("a retryable 429 leaves receipts pending with backoff", async () => {
    withEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    stubFetch(() => ({}), 429);
    const eventRef = await receive(t, alice, "payment.succeeded", { paymentId: "pay_1" });
    await run(t, alice);
    const event = await read(t, eventRef);
    expect(event).toMatchObject({ state: "pending", attempts: 1 });
    expect(event!.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(await grants(t)).toEqual([]);
  });

  test("caps provider reads per claim and leaves the rest pending", async () => {
    withEnv();
    const t = setup();
    const alice = await customer(t);
    const fetchMock = stubFetch(path => ({ ...paymentBody(path.split("/")[2]), status: "processing", subscription_id: null, charge_type: null }));
    for (let i = 0; i < MAX_PROVIDER_READS_PER_CLAIM + 5; i++) await receive(t, alice, "payment.processing", { paymentId: `pay_${i}` });
    await run(t, alice);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_PROVIDER_READS_PER_CLAIM);
    const states = (await rows(t, "billingEvents")).map(e => e.state);
    expect(states.filter(s => s === "processed")).toHaveLength(MAX_PROVIDER_READS_PER_CLAIM);
    expect(states.filter(s => s === "pending")).toHaveLength(5);
  });
});

describe("isolation", () => {
  test("another mode's purchase with the same payment id is untouched", async () => {
    const t = setup();
    const alice = await customer(t);
    const testPurchase = await checkout(t, alice, "top_up");
    await t.mutation(internal.billing.bindPurchase, { purchaseRef: testPurchase, mode: "test_mode", paymentId: "pay_1" });
    const live = await customer(t, "user_alice", "live_mode");
    await receive(t, live, "payment.succeeded", { paymentId: "pay_1" }, "live_mode");
    await reconcile(t, live, { payments: [paid(topUp("pay_1"))] });
    expect(await read(t, testPurchase)).toMatchObject({ state: "preparing" });
    expect((await rows(t, "billingPurchases")).map(p => [p.mode, p.intentId, p.state])).toEqual([
      ["test_mode", "intent_1", "preparing"], ["live_mode", "unmatched:pay_1", "quarantined"],
    ]);
    expect(await grants(t)).toEqual([]);
  });

  test("Bob's receipt never touches Alice's purchase or customer", async () => {
    const t = setup();
    const alice = await customer(t);
    const bob = await customer(t, "user_bob");
    const alicePurchase = await checkout(t, alice, "top_up");
    const before = JSON.stringify([await read(t, alicePurchase), await read(t, alice)]);
    const eventRef = await receive(t, bob, "payment.succeeded", { paymentId: "pay_1", sessionId: "cks_1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcile(t, bob, { payments: [paid(topUp("pay_1"), { sessionId: "cks_1" })] });
    expect(JSON.stringify([await read(t, alicePurchase), await read(t, alice)])).toBe(before);
    expect(await read(t, eventRef)).toMatchObject({ state: "quarantined", quarantineReason: "unsupported" });
    expect(await grants(t)).toEqual([]);
  });
});
