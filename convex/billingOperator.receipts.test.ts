// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { recordAdjustments, hasActiveHold } from "./billingReversals";
import schema from "./schema";
import type { PaymentFact } from "./billingFulfill";

const modules = import.meta.glob("./**/*.ts");
const note = { operator: "support", reason: "Reviewed privately" };
const mode = "test_mode" as const;
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => {
  for (const [message, fields] of vi.mocked(console.info).mock.calls) {
    if (String(message).startsWith("[billingOperator]")) {
      expect(fields).toMatchObject({ action: expect.any(String), operator: note.operator });
      expect(JSON.stringify(fields)).not.toContain(note.reason);
    }
  }
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function fixture(settled = true) {
  const t = convexTest(schema, modules);
  const customer = async (userId: string) => t.run(async ctx => {
    await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
    return ctx.db.insert("billingCustomers", { mode, userId, ownerTokenIdentifier: "issuer|" + userId,
      creationState: "ready", customerId: "cus_" + userId, generation: 0, inputRevision: 0, unresolvedReceipts: 0 });
  });
  const alice = await customer("alice"), bob = await customer("bob");
  const terms = { sku: "top_up" as const, productId: "pdt_topup", catalogVersion: "2026-11-17", quantity: 1, credits: 1000 };
  const purchaseRef = await t.run(ctx => ctx.db.insert("billingPurchases", {
    customerRef: alice, mode, intentId: "settled", paymentId: "pay_1", state: "open", terms,
  }));
  const fact = { paymentId: "pay_1", currency: "USD", totalMinor: 2000, taxMinor: 200,
    decision: { kind: "top_up" as const, paymentId: "pay_1", productId: terms.productId, credits: 1000, settledAt: Date.now() },
    reversal: { kind: "known" as const, refunds: [], disputes: [] } };
  const commit = async (payments: PaymentFact[] = [fact], receiptRefs: Id<"billingEvents">[] = []) => {
    const c = (await t.run(ctx => ctx.db.get(alice)))!;
    return t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: alice,
      fence: { generation: c.generation, inputRevision: c.inputRevision }, receiptRefs, payments, subscriptions: [] });
  };
  if (settled) await commit();
  const receipt = async (customerRef?: Id<"billingCustomers">, eventType = "refund.succeeded", paymentId = "pay_1", quarantineReason = "unsupported") => t.run(async ctx => {
    const ref = await ctx.db.insert("billingEvents", { customerRef, mode, eventType, paymentId, webhookId: crypto.randomUUID(),
      providerCustomerId: customerRef ? undefined : "cus_conflict", state: "quarantined", quarantineReason: quarantineReason as "unsupported",
      occurredAt: 1, receivedAt: 1, bodyDigest: "a".repeat(64), attempts: 10, nextAttemptAt: 1, generation: 0 });
    if (customerRef) {
      const row = (await ctx.db.get(customerRef))!;
      await ctx.db.patch(customerRef, { unresolvedReceipts: row.unresolvedReceipts + 1 });
    }
    return ref;
  });
  const resolve = (eventRef: Id<"billingEvents">, action: "attach" | "dismiss") => t.mutation(internal.billingOperator.resolveReceipt, { eventRef, action, ...note });
  const manual = async (eventRef: Id<"billingEvents">, amountMinor: number | null, customerRef = alice) => {
    const c = (await t.run(ctx => ctx.db.get(customerRef)))!;
    return t.mutation(internal.billingOperator.resolveUnreadableReversal, { customerRef, eventRef, amountMinor, generation: c.generation, inputRevision: c.inputRevision, ...note });
  };
  return { t, alice, bob, purchaseRef, receipt, resolve, manual, terms, fact, commit };
}

test.each(["unmapped", "digest_mismatch"])("attaches a conflicting unmapped negative (%s) with audit and counters", async reason => {
  const { t, alice, receipt, resolve } = await fixture();
  const ref = await receipt(undefined, "refund.succeeded", "pay_1", reason);
  await resolve(ref, "attach");
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({
    customerRef: alice, state: reason === "unmapped" ? "pending" : "quarantined",
    resolution: { action: "attach", ...note, at: expect.any(Number), previousState: JSON.stringify({ state: "quarantined", quarantineReason: reason }) },
  });
  expect(await t.run(ctx => ctx.db.get(alice))).toMatchObject({ unresolvedReceipts: 1, inputRevision: 1 });
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(note.reason);
});

test("re-parenting invalidates Bob's stale worker and moves both counts", async () => {
  const { t, alice, bob, receipt, resolve } = await fixture();
  const ref = await receipt(bob);
  await resolve(ref, "attach");
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ customerRef: alice, state: "pending", attempts: 0, resolution: { previousState: expect.stringContaining(bob) } });
  expect(await t.run(ctx => ctx.db.get(bob))).toMatchObject({ unresolvedReceipts: 0, inputRevision: 1 });
  expect(await t.run(ctx => ctx.db.get(alice))).toMatchObject({ unresolvedReceipts: 1, inputRevision: 1 });
  expect(await t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: bob, fence: { generation: 0, inputRevision: 0 }, receiptRefs: [], payments: [], subscriptions: [] })).toBe("stale");
});

test("dismiss refuses mapped negatives and bound unmapped receipts, but resolves orphan receipts and positives", async () => {
  const { t, alice, receipt, resolve } = await fixture();
  for (const ref of [await receipt(alice), await receipt()]) await expect(resolve(ref, "dismiss")).rejects.toThrow("INVALID_ARGUMENT");
  const orphan = await receipt(undefined, "refund.succeeded", "pay_orphan");
  await expect(resolve(orphan, "attach")).rejects.toThrow("NOT_FOUND");
  await resolve(orphan, "dismiss");
  const positive = await receipt(alice, "payment.succeeded");
  await resolve(positive, "dismiss");
  expect(await t.run(ctx => ctx.db.get(positive))).toMatchObject({ state: "processed", resolution: { action: "dismiss", ...note } });
  expect(await t.run(ctx => ctx.db.get(orphan))).toMatchObject({ state: "processed", resolution: { action: "dismiss" } });
  expect(await t.run(ctx => ctx.db.get(alice))).toMatchObject({ unresolvedReceipts: 1, inputRevision: 1 });
  await expect(resolve(positive, "attach")).rejects.toThrow("INVALID_ARGUMENT");
});

test.each(["same", "positive", "mode", "pending"])("rejects invalid attachment: %s", async shape => {
  const { t, alice, receipt, resolve } = await fixture();
  const ref = await receipt(alice, shape === "positive" ? "payment.succeeded" : "refund.succeeded");
  if (shape === "mode") await t.run(ctx => ctx.db.patch(alice, { mode: "live_mode" }));
  if (shape === "pending") await t.run(ctx => ctx.db.patch(ref, { state: "pending" }));
  await expect(resolve(ref, "attach")).rejects.toThrow();
});

test("manual amount uses the normal cumulative path once, never adds the same money twice", async () => {
  const { t, alice, purchaseRef, receipt, manual } = await fixture();
  const ref = await receipt(alice);
  await manual(ref, 1000);
  expect(await t.run(ctx => ctx.db.get(purchaseRef))).toMatchObject({ reversedMinor: 1000, revokedCredits: 500 });
  const before = await t.run(ctx => ctx.db.get(ref));
  expect(before).toMatchObject({ state: "processed", reviewedReversalMinor: 1000, resolution: { ...note, previousState: expect.stringContaining('"reversedMinor":0') } });
  await expect(manual(ref, 1000)).rejects.toThrow("INVALID_ARGUMENT");
  await manual(await receipt(alice), 1000);
  expect((await t.run(ctx => ctx.db.query("billingGrants").take(2)))[0].revoked).toBe(500);
  expect(await t.run(ctx => ctx.db.get(alice))).toMatchObject({ unresolvedReceipts: 0 });
});

test.each([2001, -1, 0.5, Number.MAX_SAFE_INTEGER])("rejects invalid manual amount %s", async amount => {
  const { alice, receipt, manual } = await fixture();
  await expect(manual(await receipt(alice), amount)).rejects.toThrow("INVALID_ARGUMENT");
});

test("no reversal is audited; wrong customer, mode, state, gross and stale fences are refused", async () => {
  const { t, alice, bob, purchaseRef, receipt, manual } = await fixture();
  const ref = await receipt(alice);
  await expect(manual(ref, 100, bob)).rejects.toThrow();
  await expect(t.mutation(internal.billingOperator.resolveUnreadableReversal, { customerRef: alice, eventRef: ref, generation: 99, inputRevision: 0, amountMinor: 100, ...note })).rejects.toThrow("CONFLICT");
  await t.run(ctx => ctx.db.patch(ref, { mode: "live_mode" }));
  await expect(manual(ref, null)).rejects.toThrow();
  await t.run(ctx => ctx.db.patch(ref, { mode, state: "pending" }));
  await expect(manual(ref, null)).rejects.toThrow();
  await t.run(ctx => ctx.db.patch(ref, { state: "quarantined" }));
  await t.run(ctx => ctx.db.patch(purchaseRef, { customerRef: bob }));
  await expect(manual(ref, 100)).rejects.toThrow();
  await t.run(ctx => ctx.db.patch(purchaseRef, { customerRef: alice, totalMinor: undefined }));
  await expect(manual(ref, 100)).rejects.toThrow("CONFLICT");
  await t.run(ctx => ctx.db.patch(purchaseRef, { totalMinor: 2000 }));
  await manual(ref, null);
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ reviewedReversalMinor: null, resolution: { ...note } });
  expect((await t.run(ctx => ctx.db.query("billingGrants").take(2)))[0].revoked).toBe(0);
});

test("support hold refuses checkout and release restores it without releasing another hold", async () => {
  const { t, alice, terms } = await fixture();
  const first = await t.mutation(internal.billingOperator.placeSupportHold, { customerRef: alice, ...note });
  const second = await t.mutation(internal.billingOperator.placeSupportHold, { customerRef: alice, ...note });
  const checkout = () => t.mutation(internal.billing.reservePurchase, { customerRef: alice, intentId: "new", terms });
  await expect(checkout()).rejects.toThrow("FORBIDDEN");
  await t.mutation(internal.billingOperator.releaseHold, { adjustmentRef: first, ...note });
  await expect(checkout()).rejects.toThrow("FORBIDDEN");
  await t.mutation(internal.billingOperator.releaseHold, { adjustmentRef: second, ...note });
  await checkout();
  expect(await t.run(ctx => ctx.db.get(first))).toMatchObject({ placedBy: { ...note }, releasedBy: { ...note, previousState: expect.stringContaining('"holdActive":true') } });
});

test.each(["expired", "other", "opened", "challenged"])("reviewed dispute release handles %s and re-holds on status change", async status => {
  const { t, alice, purchaseRef } = await fixture();
  const observe = (status: string) => t.run(async ctx => recordAdjustments(ctx, (await ctx.db.get(alice))!, "pay_1", {
    kind: "known", refunds: [], disputes: [{ disputeId: "dsp_1", status, amountMinor: 2000, currency: "USD", counted: 0, hold: true }],
  }, 2000, purchaseRef, Date.now()));
  await observe(status);
  const row = (await t.run(ctx => ctx.db.query("billingAdjustments").take(2)))[0];
  const release = () => t.mutation(internal.billingOperator.releaseHold, { adjustmentRef: row._id, ...note });
  if (["opened", "challenged"].includes(status)) return await expect(release()).rejects.toThrow("INVALID_ARGUMENT");
  await release();
  await release(); // idempotent audit preservation
  await observe(status);
  expect(await t.run(ctx => hasActiveHold(ctx, alice))).toBe(false);
  await observe("challenged");
  expect(await t.run(ctx => hasActiveHold(ctx, alice))).toBe(true);
  await observe(status);
  expect(await t.run(ctx => hasActiveHold(ctx, alice))).toBe(true);
});

test.each([{ operator: "a@b", reason: "ok" }, { operator: "ok", reason: "" }])("all new mutations validate audit inputs", async invalid => {
  const { t, alice, receipt } = await fixture();
  const eventRef = await receipt(alice);
  await expect(t.mutation(internal.billingOperator.resolveReceipt, { eventRef, action: "attach", ...invalid })).rejects.toThrow();
  await expect(t.mutation(internal.billingOperator.placeSupportHold, { customerRef: alice, ...invalid })).rejects.toThrow();
  await expect(t.mutation(internal.billingOperator.resolveUnreadableReversal, { customerRef: alice, eventRef, generation: 0, inputRevision: 0, amountMinor: null, ...invalid })).rejects.toThrow();
});

test.each(["unmapped", "reparent"])("repaired %s refund is claimed and reversed; the next positive grants", async shape => {
  const { t, alice, bob, purchaseRef, receipt, resolve, terms } = await fixture();
  const ref = await receipt(shape === "unmapped" ? undefined : bob, "refund.succeeded", "pay_1", shape === "unmapped" ? "unmapped" : "unsupported");
  await resolve(ref, "attach");
  if (shape === "reparent") {
    const purchase = await t.mutation(internal.billing.reservePurchase, { customerRef: bob, intentId: "bob_next", terms });
    await t.mutation(internal.billing.bindPurchase, { purchaseRef: purchase, mode, sessionId: "cks_bob" });
    const positive = await t.mutation(internal.billing.recordReceipt, { customerRef: bob, mode, webhookId: "wh_bob", eventType: "payment.succeeded", paymentId: "pay_bob", bodyDigest: "c".repeat(64), occurredAt: 1 });
    const claim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef: bob }))!;
    expect(await t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: bob,
      fence: { generation: claim.generation, inputRevision: claim.inputRevision }, receiptRefs: [positive!], subscriptions: [],
      payments: [{ paymentId: "pay_bob", sessionId: "cks_bob", currency: "USD", totalMinor: 2000, taxMinor: 0,
        decision: { kind: "top_up", paymentId: "pay_bob", productId: terms.productId, credits: 1000, settledAt: 1 },
        reversal: { kind: "known", refunds: [], disputes: [] } }],
    })).toBe("committed");
    expect(await t.run(ctx => ctx.db.get(purchase))).toMatchObject({ state: "settled" });
  }
  const claim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef: alice }))!;
  expect(claim.receipts.map(r => r.eventRef)).toContain(ref);
  const fact = { paymentId: "pay_1", currency: "USD", totalMinor: 2000, taxMinor: 0,
    decision: { kind: "top_up" as const, paymentId: "pay_1", productId: terms.productId, credits: 1000, settledAt: 1 },
    reversal: { kind: "known" as const, refunds: [{ refundId: "rfd_1", status: "succeeded", amountMinor: 2000, currency: "USD", isPartial: false, counted: 2000 }], disputes: [] } };
  await t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: alice,
    fence: { generation: claim.generation, inputRevision: claim.inputRevision }, receiptRefs: [ref], payments: [fact], subscriptions: [] });
  await t.mutation(internal.billingQueue.releaseCustomer, { customerRef: alice, generation: claim.generation });
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ state: "processed" });
  expect((await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", purchaseRef)).take(2)))[0].revoked).toBe(1000);
  const next = await t.mutation(internal.billing.reservePurchase, { customerRef: alice, intentId: "new", terms });
  await t.mutation(internal.billing.bindPurchase, { purchaseRef: next, mode, sessionId: "cks_2" });
  const positive = await t.mutation(internal.billing.recordReceipt, { customerRef: alice, mode, webhookId: "wh_positive", eventType: "payment.succeeded", paymentId: "pay_2", bodyDigest: "b".repeat(64), occurredAt: 1 });
  const nextClaim = (await t.mutation(internal.billingQueue.claimCustomer, { customerRef: alice }))!;
  expect(await t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: alice,
    fence: { generation: nextClaim.generation, inputRevision: nextClaim.inputRevision }, receiptRefs: [positive!], subscriptions: [],
    payments: [{ ...fact, paymentId: "pay_2", sessionId: "cks_2", decision: { ...fact.decision, paymentId: "pay_2" }, reversal: { kind: "known", refunds: [], disputes: [] } }],
  })).toBe("committed");
  expect(await t.run(ctx => ctx.db.get(next))).toMatchObject({ state: "settled" });
  expect(await t.run(ctx => ctx.db.get(alice))).toMatchObject({ unresolvedReceipts: 0 });
});

test("settlement preserves gross, not principal, for an unreadable refund review", async () => {
  const { t, alice, purchaseRef, receipt, manual, fact, commit } = await fixture();
  expect(await t.run(ctx => ctx.db.get(purchaseRef))).toMatchObject({ totalMinor: 2000, principalMinor: 1800 });
  const ref = await receipt(alice, "refund.succeeded", "pay_1", "retries_exhausted");
  await t.run(ctx => ctx.db.patch(ref, { state: "pending" }));
  await commit([{ ...fact, reversal: { kind: "unknown", reason: "amount" } }], [ref]);
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ state: "pending" });
  await t.run(ctx => ctx.db.patch(ref, { state: "quarantined" }));
  await manual(ref, 2000);
  expect(await t.run(ctx => ctx.db.get(purchaseRef))).toMatchObject({ reversedMinor: 2000, revokedCredits: 1000 });
});

test.each([null, 0, 1000])("an unsettled payment retries net of reviewed amount %s exactly once", async amount => {
  const { t, alice, purchaseRef, receipt, manual, fact, commit } = await fixture(false);
  const unknown = { ...fact, reversal: { kind: "unknown" as const, reason: "amount" as const } };
  const ref = await receipt(alice, "refund.succeeded", "pay_1", "retries_exhausted");
  await t.run(ctx => ctx.db.patch(ref, { state: "pending" }));
  await commit([unknown], [ref]);
  expect(await t.run(ctx => ctx.db.get(purchaseRef))).toMatchObject({ state: "open", totalMinor: 2000 });
  expect(await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", purchaseRef)).take(2))).toHaveLength(0);
  await t.run(ctx => ctx.db.patch(ref, { state: "quarantined" }));
  await manual(ref, amount);
  expect(await t.run(ctx => ctx.db.get(ref))).toMatchObject({ reviewedReversalMinor: amount });
  await expect(manual(ref, amount)).rejects.toThrow("INVALID_ARGUMENT");
  const retry = (await t.run(ctx => ctx.db.query("billingEvents").withIndex("by_customerRef_and_state", q => q.eq("customerRef", alice).eq("state", "pending")).take(2)))[0];
  expect(retry.eventType).toBe("payment.reconcile");
  await commit([unknown], [retry._id]);
  await commit([unknown]);
  const settled = (await t.run(ctx => ctx.db.get(purchaseRef)))!;
  expect(settled.state).toBe("settled");
  expect(settled.revokedCredits ?? 0).toBe(amount ? 500 : 0);
  const lots = await t.run(ctx => ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", purchaseRef)).take(2));
  expect(lots).toHaveLength(1);
  expect(lots[0].quantity - lots[0].revoked).toBe(amount ? 500 : 1000);
  // A subsequent unreadable negative is never covered by the earlier review.
  const later = await receipt(alice);
  await t.run(ctx => ctx.db.patch(later, { state: "pending" }));
  expect(await commit([unknown], [later])).toBe("blocked");
  expect(await t.run(ctx => ctx.db.get(later))).toMatchObject({ state: "pending" });
});
