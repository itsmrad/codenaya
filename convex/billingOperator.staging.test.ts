// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { PaymentFact } from "./billingFulfill";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const mode = "test_mode" as const;
const note = { operator: "support", reason: "Reviewed privately" };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
async function setup() {
  const t = convexTest(schema, modules);
  const customer = (userId: string) => t.run(async ctx => {
    await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
    return ctx.db.insert("billingCustomers", { mode, userId, ownerTokenIdentifier: "issuer|" + userId,
      customerId: "cus_" + userId, creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0 });
  });
  const alice = await customer("alice"), bob = await customer("bob");
  const fact: PaymentFact = { paymentId: "pay_1", totalMinor: 2000, taxMinor: 200, currency: "USD",
    decision: { kind: "period", paymentId: "pay_1", subscriptionId: "sub_1", productId: "pdt_pro",
      credits: 2000, serviceStart: Date.now(), serviceEnd: Date.now() + 100000, settledAt: Date.now() },
    reversal: { kind: "unknown", reason: "amount" } };
  const commit = async (payments = [fact], receiptRefs: Id<"billingEvents">[] = []) => {
    const c = (await t.run(ctx => ctx.db.get(alice)))!;
    return t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: alice,
      fence: { generation: c.generation, inputRevision: c.inputRevision }, payments, receiptRefs, subscriptions: [] });
  };
  const purchase = () => t.run(ctx => ctx.db.query("billingPurchases")
    .withIndex("by_mode_and_paymentId", q => q.eq("mode", mode).eq("paymentId", "pay_1")).unique());
  const noGrant = async () => {
    expect(await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_userId_and_mode_and_kind_and_exhausted_and_expiresAt", q =>
      q.eq("userId", "alice").eq("mode", mode).eq("kind", "current_period")).take(2))).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.query("creditAccounts").withIndex("by_userId", q => q.eq("userId", "alice")).unique())).toBeNull();
  };
  return { t, alice, bob, fact, commit, purchase, noGrant };
}

test("an owned renewal without a purchase stages no entitlement and settles net once after review", async () => {
  const { t, alice, fact, commit, purchase, noGrant } = await setup();
  const subscription = await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode, subscriptionId: "sub_1", productId: "pdt_pro" });
  const before = await t.run(ctx => ctx.db.get(subscription));
  const ref = (await t.mutation(internal.billing.recordReceipt, { customerRef: alice, mode, webhookId: "wh_refund", eventType: "refund.succeeded", paymentId: "pay_1", bodyDigest: "a".repeat(64), occurredAt: 1 }))!;
  await commit();
  const staged = (await purchase())!;
  expect(staged).toMatchObject({ customerRef: alice, paymentId: "pay_1", state: "open", totalMinor: 2000 });
  await noGrant();
  expect(await t.run(ctx => ctx.db.get(subscription))).toEqual(before);
  expect((await t.run(ctx => ctx.db.get(alice)))?.activeSubscriptionRef).toBeUndefined();
  await t.run(ctx => ctx.db.patch(ref, { state: "quarantined", quarantineReason: "retries_exhausted" }));
  const c = (await t.run(ctx => ctx.db.get(alice)))!;
  const review = { customerRef: alice, eventRef: ref, generation: c.generation, inputRevision: c.inputRevision, amountMinor: 1000, ...note };
  await t.mutation(internal.billingOperator.resolveUnreadableReversal, review);
  await expect(t.mutation(internal.billingOperator.resolveUnreadableReversal, review)).rejects.toThrow();
  const pending = await t.run(ctx => ctx.db.query("billingEvents").withIndex("by_customerRef_and_state_and_nextAttemptAt", q =>
    q.eq("customerRef", alice).eq("state", "pending")).take(2));
  expect(pending).toHaveLength(1);
  expect(pending[0].eventType).toBe("payment.reconcile");
  await commit([fact], [pending[0]._id]);
  await commit();
  const lots = await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", staged._id)).take(2));
  expect(lots).toHaveLength(1);
  expect(lots[0]).toMatchObject({ quantity: 2000, revoked: 1000 });
  expect(await purchase()).toMatchObject({ state: "settled", revokedCredits: 1000 });
  const later = (await t.mutation(internal.billing.recordReceipt, { customerRef: alice, mode, webhookId: "wh_later", eventType: "refund.succeeded", paymentId: "pay_1", bodyDigest: "b".repeat(64), occurredAt: 2 }))!;
  expect(await commit([fact], [later])).toBe("blocked");
  expect(await t.run(ctx => ctx.db.get(later))).toMatchObject({ state: "pending" });
});

test.each(["missing", "foreign", "product", "mode", "duplicate"])("renewal staging refuses %s subscription or period", async shape => {
  const { t, alice, bob, fact, commit, purchase, noGrant } = await setup();
  if (shape !== "missing") await t.run(ctx => ctx.db.insert("billingSubscriptions", {
    customerRef: shape === "foreign" ? bob : alice, mode: shape === "mode" ? "live_mode" : mode,
    subscriptionId: "sub_1", productId: shape === "product" ? "wrong" : "pdt_pro", status: "pending",
  }));
  if (shape === "duplicate") {
    await commit();
    await commit([{ ...fact, paymentId: "pay_2", decision: { ...fact.decision, paymentId: "pay_2" } }]);
    expect(await t.run(ctx => ctx.db.query("billingPurchases").withIndex("by_mode_and_paymentId", q => q.eq("mode", mode).eq("paymentId", "pay_2")).unique())).toBeNull();
  } else {
    await commit();
    expect(await purchase()).toBeNull();
  }
  await noGrant();
});

test.each(["foreign", "mode", "terms", "duplicate", "unmatched"])("checkout staging refuses %s binding", async shape => {
  const { t, alice, bob, fact, commit, purchase, noGrant } = await setup();
  const terms = { sku: "top_up" as const, productId: shape === "terms" ? "wrong" : "pdt_topup", quantity: 1, credits: 1000, catalogVersion: "2026-11-17" };
  const original = shape !== "unmatched" ? await t.run(ctx => ctx.db.insert("billingPurchases", {
    customerRef: shape === "foreign" ? bob : alice, mode: shape === "mode" ? "live_mode" : mode,
    intentId: "checkout", sessionId: "cks_1", state: "open", terms, ...(shape === "duplicate" ? { paymentId: "pay_old" } : {}),
  })) : null;
  const before = original && await t.run(ctx => ctx.db.get(original));
  await commit([{ ...fact, sessionId: "cks_1", decision: { kind: "top_up", paymentId: "pay_1", productId: "pdt_topup", credits: 1000, settledAt: Date.now() } }]);
  if (shape === "foreign") {
    expect(await purchase()).toMatchObject({ customerRef: alice, state: "quarantined", intentId: "unmatched:pay_1" });
    expect((await purchase())?.stagedGrantKey).toBeUndefined();
    expect(await t.run(ctx => ctx.db.get(original!))).toEqual(before);
  } else expect(await purchase()).toBeNull();
  await noGrant();
});

test("two facts naming one session re-read the staged binding without collision", async () => {
  const { t, alice, fact, commit, noGrant } = await setup();
  const ref = await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: alice, mode, intentId: "checkout", sessionId: "cks_1", state: "open",
    terms: { sku: "top_up", productId: "pdt_topup", quantity: 1, credits: 1000, catalogVersion: "2026-11-17" } }));
  const payments: PaymentFact[] = ["pay_1", "pay_2"].map(paymentId => ({ ...fact, paymentId, sessionId: "cks_1",
    decision: { kind: "top_up", paymentId, productId: "pdt_topup", credits: 1000, settledAt: Date.now() } }));
  await commit(payments);
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ paymentId: "pay_1", totalMinor: 2000, state: "open" });
  expect(await t.run(ctx => ctx.db.query("billingPurchases").withIndex("by_mode_and_paymentId", q => q.eq("mode", mode).eq("paymentId", "pay_2")).unique())).toBeNull();
  await noGrant();
});

test.each(["first checkout", "catalog drift", "deleted owner"])("Pro %s without a subscription stays pending then recovers once", async shape => {
  const { t, alice, fact, commit, noGrant } = await setup();
  if (fact.decision.kind !== "period") throw new Error("Expected period fixture");
  const positive: PaymentFact = { ...fact, sessionId: "cks_pro", decision: {
    ...fact.decision, credits: shape === "catalog drift" ? 3000 : 2000,
  } };
  const ref = await t.run(async ctx => {
    const ref = await ctx.db.insert("billingPurchases", { customerRef: alice, mode, intentId: "first_pro", sessionId: "cks_pro", state: "open",
      terms: { sku: "pro_monthly", productId: "pdt_pro", quantity: 1, credits: 2000, catalogVersion: "2026-11-17" } });
    await ctx.db.patch(alice, { pendingPurchaseRef: ref, ...(shape === "deleted owner" ? { deletedAt: 1 } : {}) });
    return ref;
  });
  const receive = (eventType: string) => t.mutation(internal.billing.recordReceipt, { customerRef: alice, mode, webhookId: eventType,
    eventType, paymentId: "pay_1", bodyDigest: "a".repeat(64), occurredAt: 1 });
  const payment = (await receive("payment.succeeded"))!, refund = (await receive("refund.succeeded"))!;
  await commit([positive], [payment, refund]);
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ state: "open", paymentId: "pay_1", totalMinor: 2000 });
  expect((await t.run(ctx => ctx.db.get(ref)))?.subscriptionId).toBeUndefined();
  expect(await t.run(ctx => ctx.db.query("billingSubscriptions").withIndex("by_mode_and_subscriptionId", q => q.eq("mode", mode).eq("subscriptionId", "sub_1")).unique())).toBeNull();
  for (const receipt of [payment, refund]) expect(await t.run(ctx => ctx.db.get(receipt))).toMatchObject({ state: "pending" });
  expect((await t.run(ctx => ctx.db.get(alice)))?.activeSubscriptionRef).toBeUndefined();
  await noGrant();
  await t.run(ctx => ctx.db.patch(refund, { state: "quarantined", quarantineReason: "retries_exhausted" }));
  const c = (await t.run(ctx => ctx.db.get(alice)))!;
  await t.mutation(internal.billingOperator.resolveUnreadableReversal, { customerRef: alice, eventRef: refund,
    generation: c.generation, inputRevision: c.inputRevision, amountMinor: 1000, ...note });
  const pending = await t.run(ctx => ctx.db.query("billingEvents").withIndex("by_customerRef_and_state_and_nextAttemptAt", q => q.eq("customerRef", alice).eq("state", "pending")).take(2));
  expect(pending).toHaveLength(1);
  expect(pending[0]._id).toBe(payment);
  await commit([positive], [payment]);
  await commit([positive]);
  for (const receipt of [payment, refund]) expect(await t.run(ctx => ctx.db.get(receipt))).toMatchObject({ state: "processed" });
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ state: "settled", reversedMinor: 1000 });
  const lots = await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", ref)).take(2));
  if (shape === "deleted owner") {
    expect(lots).toHaveLength(0);
    await noGrant();
    expect((await t.run(ctx => ctx.db.get(ref)))?.cancellationRecoveryRequired).toBe(true);
  } else {
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ quantity: 2000, revoked: 1000 });
  }
  const key = (await t.run(ctx => ctx.db.get(ref)))!.stagedGrantKey;
  await commit([{ ...positive, decision: { ...fact.decision, serviceStart: fact.decision.serviceStart + 100000, serviceEnd: fact.decision.serviceEnd + 100000 } }]);
  expect((await t.run(ctx => ctx.db.get(ref)))!.stagedGrantKey).toBe(key);
});

test.each(["missing purchase", "foreign subscription", "wrong product"])("staging refusal (%s) preserves pending receipt outcomes", async shape => {
  const { t, alice, bob, fact, commit } = await setup();
  if (shape !== "missing purchase") await t.run(async ctx => {
    await ctx.db.insert("billingPurchases", { customerRef: alice, mode, intentId: "pro", sessionId: "cks_pro", state: "open",
      terms: { sku: "pro_monthly", productId: "pdt_pro", quantity: 1, credits: 2000, catalogVersion: "2026-11-17" } });
    await ctx.db.insert("billingSubscriptions", { customerRef: shape === "foreign subscription" ? bob : alice, mode,
      subscriptionId: "sub_1", productId: shape === "wrong product" ? "wrong" : "pdt_pro", status: "pending" });
  });
  const refs: Id<"billingEvents">[] = [];
  for (const eventType of ["payment.succeeded", "refund.succeeded"]) refs.push((await t.mutation(internal.billing.recordReceipt,
    { customerRef: alice, mode, webhookId: eventType, eventType, paymentId: "pay_1", bodyDigest: "a".repeat(64), occurredAt: 1 }))!);
  await commit([{ ...fact, sessionId: "cks_pro" }], refs);
  for (const ref of refs) expect(await t.run(ctx => ctx.db.get(ref!))).toMatchObject({ state: "pending" });
});

test("staging association moves the revision and defers an otherwise grantable positive", async () => {
  const { t, alice, fact, commit, noGrant } = await setup();
  await t.run(async ctx => {
    await ctx.db.insert("billingPurchases", { customerRef: alice, mode, intentId: "unknown", sessionId: "cks_unknown", state: "open",
      terms: { sku: "top_up", productId: "pdt_topup", quantity: 1, credits: 1000, catalogVersion: "2026-11-17" } });
    await ctx.db.insert("billingPurchases", { customerRef: alice, mode, intentId: "known", sessionId: "cks_known", state: "open",
      terms: { sku: "top_up", productId: "pdt_topup", quantity: 1, credits: 1000, catalogVersion: "2026-11-17" } });
  });
  const unmapped = (await t.mutation(internal.billing.recordReceipt, { mode, webhookId: "wh_unmapped", eventType: "refund.succeeded",
    paymentId: "pay_1", bodyDigest: "a".repeat(64), occurredAt: 1 }))!;
  const before = (await t.run(ctx => ctx.db.get(alice)))!.inputRevision;
  expect(await commit([
    { ...fact, sessionId: "cks_unknown", decision: { kind: "top_up", paymentId: "pay_1", productId: "pdt_topup", credits: 1000, settledAt: Date.now() } },
    { ...fact, paymentId: "pay_2", sessionId: "cks_known", decision: { kind: "top_up", paymentId: "pay_2", productId: "pdt_topup", credits: 1000, settledAt: Date.now() }, reversal: { kind: "known", refunds: [], disputes: [] } },
  ])).toBe("blocked");
  expect((await t.run(ctx => ctx.db.get(alice)))!.inputRevision).toBeGreaterThan(before);
  expect(await t.run(ctx => ctx.db.get(unmapped))).toMatchObject({ customerRef: alice, state: "pending" });
  await noGrant();
  expect(await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_userId_and_mode_and_kind_and_exhausted_and_expiresAt", q => q.eq("userId", "alice").eq("mode", mode).eq("kind", "top_up")).take(2))).toHaveLength(0);
});
