// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertBillingFence, MAX_ASSOCIATE_BATCH } from "./billing";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const NOW = Date.UTC(2026, 10, 10, 12);
const P1 = { serviceStart: Date.UTC(2026, 10, 1), serviceEnd: Date.UTC(2026, 11, 1) };
const PRO = "pdt_pro";
type Mode = "test_mode" | "live_mode";
type Ids = { paymentId?: string; subscriptionId?: string; sessionId?: string };

const setup = () => convexTest(schema, modules);
type T = ReturnType<typeof setup>;

// Attached receipts schedule processing; fake timers keep those runs from firing mid- or post-test.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** An unbound customer: early receipts for it arrive unmapped. */
async function unbound(t: T, userId = "user_alice", mode: Mode = "test_mode") {
  await t.run(async ctx => {
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique();
    if (!user) await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
  });
  return t.mutation(internal.billing.ensureCustomer, { mode, userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}` });
}
const bind = (t: T, customerRef: Id<"billingCustomers">, userId = "user_alice") =>
  t.mutation(internal.billing.bindCustomer, { customerRef, customerId: `cus_${userId}` });

let seq = 0;
const receive = (t: T, args: {
  customerRef?: Id<"billingCustomers">; providerCustomerId?: string; eventType?: string; mode?: Mode; webhookId?: string; digest?: string;
} & Ids = {}) => {
  const { customerRef, providerCustomerId, eventType = "payment.succeeded", mode = "test_mode", webhookId = `wh_${++seq}`, digest = "a", ...ids } = args;
  return t.mutation(internal.billing.recordReceipt, {
    customerRef, providerCustomerId, mode, webhookId, eventType, bodyDigest: digest.repeat(64), occurredAt: 1, ...ids,
  });
};

const read = <N extends "billingCustomers" | "billingEvents">(t: T, id: Id<N>) => t.run(ctx => ctx.db.get(id));
const events = (t: T) => t.run(ctx => ctx.db.query("billingEvents").take(200));
const grants = (t: T) => t.run(ctx => ctx.db.query("billingGrants").take(10));
const scheduled = (t: T, name: string) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").take(500)).filter(job => job.name.includes(name) && job.state.kind === "pending"));

/** A Pro checkout bound to `cks_1` and `sub_1`, as checkout leaves it. */
async function checkout(t: T, customerRef: Id<"billingCustomers">) {
  const purchaseRef = await t.mutation(internal.billing.reservePurchase, {
    customerRef, intentId: "intent_1", terms: { sku: "pro_monthly", catalogVersion: "2026-11-17", productId: PRO, quantity: 1, credits: 2000 },
  });
  await t.mutation(internal.billing.bindSubscription, { customerRef, mode: "test_mode", subscriptionId: "sub_1", productId: PRO });
  await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", sessionId: "cks_1", subscriptionId: "sub_1" });
  return purchaseRef;
}

const period = (paymentId: string) => ({
  paymentId, sessionId: "cks_1", currency: "USD", totalMinor: 2000, taxMinor: 180,
  decision: { kind: "period" as const, paymentId, subscriptionId: "sub_1", productId: PRO, ...P1, credits: 2000, settledAt: P1.serviceStart },
});
const sub = (userId = "user_alice") => ({
  subscriptionId: "sub_1", customerId: `cus_${userId}`, productId: PRO, status: "active", nextBillingAt: P1.serviceEnd, cancelAtNextBillingDate: false,
});

/** Claims and commits a period for `paymentId` over every claimed receipt except refunds and disputes, as the reconciler does. */
async function reconcile(t: T, customerRef: Id<"billingCustomers">, paymentId = "pay_1", userId = "user_alice", payments: object[] = [period(paymentId)]) {
  const claim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef }))!;
  const result = await t.mutation(internal.billingFulfill.commitReconciliation, {
    customerRef, fence: { generation: claim.generation, inputRevision: claim.inputRevision },
    receiptRefs: claim.receipts.filter(r => !/^(refund|dispute)\./.test(r.eventType)).map(r => r.eventRef),
    payments: payments as never, subscriptions: [sub(userId)],
  });
  await t.mutation(internal.billingQueue.releaseCustomer, { customerRef, generation: claim.generation });
  return result;
}

/** Runs scheduled continuations by hand (the scheduler's other jobs stay queued) until none is new; returns how many ran. */
async function drainContinuations(t: T) {
  const ran = new Set<string>();
  for (;;) {
    const next = (await scheduled(t, "associateMoreUnmapped")).find(job => !ran.has(job._id));
    if (!next) return ran.size;
    ran.add(next._id);
    await t.mutation(internal.billing.associateMoreUnmapped, next.args[0] as never);
  }
}

describe("mapping at receipt time", () => {
  test("a receipt recorded after bindCustomer committed is mapped, though the receiver saw no customer", async () => {
    const t = setup();
    const alice = await unbound(t);
    await bind(t, alice);
    // The receiver passes only the payload's provider customer id; recordReceipt maps it in its own transaction.
    const refund = await receive(t, { providerCustomerId: "cus_user_alice", eventType: "refund.succeeded", paymentId: "pay_0" });
    const row = await read(t, refund);
    expect(row).toMatchObject({ customerRef: alice, state: "pending" });
    expect(row?.providerCustomerId).toBeUndefined();
    expect(await read(t, alice)).toMatchObject({ inputRevision: 1, unresolvedReceipts: 1 });
    await checkout(t, alice);
    await receive(t, { customerRef: alice, paymentId: "pay_1" });
    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
  });

  test("a refund with no customer in its payload maps through the purchase bound to its payment and blocks grants", async () => {
    const t = setup();
    const alice = await unbound(t);
    await bind(t, alice);
    const purchaseRef = await checkout(t, alice);
    await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", paymentId: "pay_1" });
    const refund = await receive(t, { eventType: "refund.succeeded", paymentId: "pay_1" });
    expect(await read(t, refund)).toMatchObject({ customerRef: alice, state: "pending" });
    // Another mode's purchase never maps it.
    const otherMode = await receive(t, { eventType: "refund.succeeded", paymentId: "pay_1", mode: "live_mode" });
    expect((await read(t, otherMode))?.customerRef).toBeUndefined();
    await receive(t, { customerRef: alice, paymentId: "pay_1" });
    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
  });
});

describe("associating unmapped receipts", () => {
  test("binding the customer attaches its early receipt and dirties the fence", async () => {
    const t = setup();
    const alice = await unbound(t);
    const eventRef = await receive(t, { providerCustomerId: "cus_user_alice" });
    const before = await t.query(internal.billing.getFence, { customerRef: alice });
    expect(await scheduled(t, "processCustomer")).toEqual([]);

    await bind(t, alice);
    expect(await read(t, eventRef)).toMatchObject({ customerRef: alice, state: "pending", attempts: 0, nextAttemptAt: NOW });
    expect((await read(t, eventRef))?.quarantineReason).toBeUndefined();
    expect(await read(t, alice)).toMatchObject({ inputRevision: before.inputRevision + 1, unresolvedReceipts: 1 });
    expect(await scheduled(t, "processCustomer")).toHaveLength(1);
    await expect(t.run(ctx => assertBillingFence(ctx, alice, before))).rejects.toThrow("conflicts");
  });

  test("a same-digest redelivery after mapping attaches the row without inserting another", async () => {
    const t = setup();
    const alice = await unbound(t);
    // Stored before the receiver kept provider customer ids, so binding alone cannot find it.
    const eventRef = await receive(t, { webhookId: "wh_legacy" });
    await bind(t, alice);
    expect(await read(t, eventRef)).toMatchObject({ state: "quarantined", quarantineReason: "unmapped" });

    expect(await receive(t, { customerRef: alice, webhookId: "wh_legacy" })).toBe(eventRef);
    expect(await events(t)).toHaveLength(1);
    expect(await read(t, eventRef)).toMatchObject({ customerRef: alice, state: "pending" });
    expect(await read(t, alice)).toMatchObject({ inputRevision: 1, unresolvedReceipts: 1 });
  });

  test("a different-digest redelivery stays unmapped; a later binding attaches it quarantined, counted, and fencing positives", async () => {
    const t = setup();
    const alice = await unbound(t);
    const eventRef = await receive(t, { providerCustomerId: "cus_user_alice", eventType: "refund.succeeded", paymentId: "pay_1", webhookId: "wh_1" });
    await receive(t, { providerCustomerId: "cus_user_alice", eventType: "refund.succeeded", paymentId: "pay_1", webhookId: "wh_1", digest: "b" });
    expect(await events(t)).toHaveLength(1);
    const mismatched = await read(t, eventRef);
    expect(mismatched).toMatchObject({ state: "quarantined", quarantineReason: "digest_mismatch" });
    expect(mismatched?.customerRef).toBeUndefined();

    await bind(t, alice);
    expect(await read(t, eventRef)).toMatchObject({ customerRef: alice, state: "quarantined", quarantineReason: "digest_mismatch" });
    expect(await read(t, alice)).toMatchObject({ inputRevision: 1, unresolvedReceipts: 1 });
    expect(await scheduled(t, "processCustomer")).toEqual([]);

    await checkout(t, alice);
    await receive(t, { customerRef: alice, paymentId: "pay_1" });
    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
  });

  test("an unmapped refund attached at bindCustomer blocks that customer's positives", async () => {
    const t = setup();
    const alice = await unbound(t);
    // For another payment: only the customer-wide negative check can see it once attached.
    const refund = await receive(t, { providerCustomerId: "cus_user_alice", eventType: "refund.succeeded", paymentId: "pay_0" });
    await bind(t, alice);
    expect(await read(t, refund)).toMatchObject({ customerRef: alice, state: "pending" });
    await checkout(t, alice);
    const payment = await receive(t, { customerRef: alice, paymentId: "pay_1" });
    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect([(await read(t, payment))?.state, (await read(t, refund))?.state]).toEqual(["pending", "pending"]);
  });

  test("a payment-keyed association skips a row whose provider customer is someone else", async () => {
    const t = setup();
    const alice = await unbound(t);
    await bind(t, alice);
    const purchaseRef = await checkout(t, alice);
    const bobs = await receive(t, { providerCustomerId: "cus_user_bob", eventType: "refund.succeeded", paymentId: "pay_1" });
    await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", paymentId: "pay_1" });
    const row = await read(t, bobs);
    expect(row).toMatchObject({ state: "quarantined", quarantineReason: "unmapped", providerCustomerId: "cus_user_bob" });
    expect(row?.customerRef).toBeUndefined();
    expect(await read(t, alice)).toMatchObject({ unresolvedReceipts: 0 });
    // Still unmapped, it keeps blocking the payment's positive.
    await receive(t, { customerRef: alice, paymentId: "pay_1" });
    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
  });

  test("an unmapped refund is attached when its payment's purchase is bound, and the grant stays blocked", async () => {
    const t = setup();
    const alice = await unbound(t);
    await bind(t, alice);
    const purchaseRef = await checkout(t, alice);
    const refund = await receive(t, { eventType: "refund.succeeded", paymentId: "pay_1" });
    await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", paymentId: "pay_1" });
    expect(await read(t, refund)).toMatchObject({ customerRef: alice, state: "pending" });

    await receive(t, { customerRef: alice, paymentId: "pay_1" });
    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect(await read(t, refund)).toMatchObject({ state: "pending" });
  });

  test("the commit attaches an unmapped refund for its payment and grants nothing in that commit", async () => {
    const t = setup();
    const alice = await unbound(t);
    await bind(t, alice);
    await checkout(t, alice);
    const refund = await receive(t, { eventType: "refund.succeeded", paymentId: "pay_1" });
    const payment = await receive(t, { customerRef: alice, paymentId: "pay_1" });
    const updated = await receive(t, { customerRef: alice, eventType: "subscription.updated", subscriptionId: "sub_1" });
    const revision = (await read(t, alice))!.inputRevision;

    expect(await reconcile(t, alice)).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("creditAccounts").take(1))).toEqual([]);
    expect(await read(t, refund)).toMatchObject({ customerRef: alice, state: "pending" });
    expect([(await read(t, payment))?.state, (await read(t, updated))?.state]).toEqual(["pending", "processed"]);
    // +1 refund attached, -1 subscription receipt processed, in the same transaction.
    expect(await read(t, alice)).toMatchObject({ inputRevision: revision + 1, unresolvedReceipts: 2 });
  });

  test("a foreign provider customer, another mode and already-mapped, processed or ignored rows are untouched", async () => {
    const t = setup();
    const bob = await unbound(t, "user_bob");
    await bind(t, bob, "user_bob");
    const alice = await unbound(t);
    const foreign = await receive(t, { providerCustomerId: "cus_user_carol" });
    const otherMode = await receive(t, { providerCustomerId: "cus_user_alice", mode: "live_mode" });
    const others = await t.run(async ctx => {
      const base = { mode: "test_mode" as const, eventType: "payment.succeeded", bodyDigest: "c".repeat(64), occurredAt: 1, receivedAt: 1,
        attempts: 0, nextAttemptAt: 1, generation: 0, providerCustomerId: "cus_user_alice" };
      return [
        await ctx.db.insert("billingEvents", { ...base, webhookId: "wh_mapped", customerRef: bob, state: "quarantined", quarantineReason: "retries_exhausted" }),
        await ctx.db.insert("billingEvents", { ...base, webhookId: "wh_processed", state: "processed" }),
        await ctx.db.insert("billingEvents", { ...base, webhookId: "wh_ignored", state: "ignored" }),
      ];
    });
    const before = await Promise.all([foreign, otherMode, ...others].map(ref => read(t, ref)));
    await bind(t, alice);
    expect(await Promise.all([foreign, otherMode, ...others].map(ref => read(t, ref)))).toEqual(before);
    expect(await read(t, alice)).toMatchObject({ inputRevision: 0, unresolvedReceipts: 0 });
    expect(await read(t, bob)).toMatchObject({ unresolvedReceipts: 0 });
  });

  test("a deleted owner's early receipt still attaches, and the reconciler suppresses the grant", async () => {
    const t = setup();
    const alice = await unbound(t);
    const eventRef = await receive(t, { providerCustomerId: "cus_user_alice", subscriptionId: "sub_1", paymentId: "pay_1" });
    await t.run(async ctx => {
      const user = (await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", "user_alice")).unique())!;
      await ctx.db.patch("users", user._id, { deletedAt: 1 });
    });
    await bind(t, alice);
    expect(await read(t, eventRef)).toMatchObject({ customerRef: alice, state: "pending" });
    await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode: "test_mode", subscriptionId: "sub_1", productId: PRO });

    expect(await reconcile(t, alice)).toBe("committed");
    expect(await grants(t)).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("creditAccounts").take(1))).toEqual([]);
    const [purchase] = await t.run(ctx => ctx.db.query("billingPurchases").take(2));
    expect(purchase).toMatchObject({ state: "settled", cancellationRecoveryRequired: true });
    expect(await read(t, eventRef)).toMatchObject({ state: "processed" });
  });

  test("a backlog larger than one batch drains through the continuation", async () => {
    const t = setup();
    const alice = await unbound(t);
    const total = MAX_ASSOCIATE_BATCH + 10;
    for (let i = 0; i < total; i++) await receive(t, { providerCustomerId: "cus_user_alice" });
    await bind(t, alice);
    expect(await read(t, alice)).toMatchObject({ inputRevision: 1, unresolvedReceipts: MAX_ASSOCIATE_BATCH });

    expect(await drainContinuations(t)).toBe(1);
    expect(await read(t, alice)).toMatchObject({ inputRevision: 2, unresolvedReceipts: total });
    expect((await events(t)).every(row => row.customerRef === alice && row.state === "pending")).toBe(true);
  });

  test("the continuation pages past rows that stay quarantined in its range", async () => {
    const t = setup();
    const alice = await unbound(t);
    // A full first batch of digest_mismatch rows: attached but still quarantined, so they stay in the index range.
    for (let i = 0; i < MAX_ASSOCIATE_BATCH; i++) {
      await receive(t, { providerCustomerId: "cus_user_alice", webhookId: `wh_mismatch_${i}` });
      await receive(t, { providerCustomerId: "cus_user_alice", webhookId: `wh_mismatch_${i}`, digest: "b" });
    }
    const late = await receive(t, { providerCustomerId: "cus_user_alice" });
    await bind(t, alice);
    expect(await read(t, late)).toMatchObject({ state: "quarantined", quarantineReason: "unmapped" });

    expect(await drainContinuations(t)).toBeGreaterThanOrEqual(1);
    expect(await read(t, late)).toMatchObject({ customerRef: alice, state: "pending" });
    expect(await read(t, alice)).toMatchObject({ unresolvedReceipts: MAX_ASSOCIATE_BATCH + 1 });
    const rows = await events(t);
    expect(rows.filter(row => row.state === "quarantined" && row.quarantineReason === "digest_mismatch" && row.customerRef === alice))
      .toHaveLength(MAX_ASSOCIATE_BATCH);
  });

  test("when one of two positives attaches a receipt, neither grants in that commit", async () => {
    const t = setup();
    const alice = await unbound(t);
    await bind(t, alice);
    await checkout(t, alice);
    const P2 = { serviceStart: P1.serviceEnd, serviceEnd: Date.UTC(2027, 0, 1) };
    // Not a negative: only the attachment itself withholds the grants.
    const early = await receive(t, { paymentId: "pay_2" });
    const first = await receive(t, { customerRef: alice, paymentId: "pay_1" });
    const second = await receive(t, { customerRef: alice, paymentId: "pay_2" });
    const pay2 = { paymentId: "pay_2", currency: "USD", totalMinor: 2000, taxMinor: 180, decision: { ...period("pay_2").decision, ...P2, settledAt: P2.serviceStart } };
    expect(await reconcile(t, alice, "pay_1", "user_alice", [period("pay_1"), pay2])).toBe("blocked");
    expect(await grants(t)).toEqual([]);
    expect(await read(t, early)).toMatchObject({ customerRef: alice, state: "pending" });
    expect([(await read(t, first))?.state, (await read(t, second))?.state]).toEqual(["pending", "pending"]);
    expect(await t.run(ctx => ctx.db.query("billingPurchases").take(5))).toHaveLength(1);
  });
});
