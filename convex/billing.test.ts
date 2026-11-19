// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertBillingFence } from "./billing";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const setup = () => convexTest(schema, modules);
type TestBackend = ReturnType<typeof setup>;
const identity = { ownerTokenIdentifier: "https://clerk.synthetic|user_alice", userId: "user_alice" };
const terms = { sku: "pro_monthly" as const, catalogVersion: "synthetic-v1", productId: "product_pro", quantity: 1, credits: 2000 };
const mode = "test_mode" as const;
const receipt = { mode, webhookId: "wh_synthetic", eventType: "payment.succeeded", bodyDigest: "a".repeat(64), occurredAt: 123 };

async function customer(t: TestBackend, userId = identity.userId, mode: "test_mode" | "live_mode" = "test_mode") {
  await t.run(async ctx => {
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique();
    if (!user) await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
  });
  return t.mutation(internal.billing.ensureCustomer, { mode, userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}` });
}

async function readyCustomer(t: TestBackend, userId = identity.userId, mode: "test_mode" | "live_mode" = "test_mode") {
  const customerRef = await customer(t, userId, mode);
  await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: `cus_${userId}` });
  return customerRef;
}

const reserve = (t: TestBackend, customerRef: Id<"billingCustomers">, intentId = "intent_synthetic") =>
  t.mutation(internal.billing.reservePurchase, { customerRef, intentId, terms });
const readCustomer = (t: TestBackend, customerRef: Id<"billingCustomers">) =>
  t.run(ctx => ctx.db.get("billingCustomers", customerRef));
// Mapped receipts schedule processing; fake timers keep those runs from firing mid- or post-test.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const assertClean = async (t: TestBackend, customerRef: Id<"billingCustomers">) => {
  const captured = await t.query(internal.billing.getFence, { customerRef });
  return t.run(ctx => assertBillingFence(ctx, customerRef, captured));
};

describe("billing identity and additive schema", () => {
  test("old profile, project and credit rows stay valid without billing fields", async () => {
    const t = setup();
    const rows = await t.run(async ctx => {
      const userRef = await ctx.db.insert("users", { clerkUserId: identity.userId, updatedAt: 1 });
      const projectRef = await ctx.db.insert("projects", { name: "Old app", ownerId: identity.userId, updatedAt: 1 });
      const accountRef = await ctx.db.insert("creditAccounts", {
        userId: identity.userId, plan: "free", periodStartsAt: 1, periodUsed: 4, dayStartsAt: 1, dayUsed: 4,
      });
      return Promise.all([ctx.db.get("users", userRef), ctx.db.get("projects", projectRef), ctx.db.get("creditAccounts", accountRef)]);
    });
    expect(rows[0]).toMatchObject({ clerkUserId: identity.userId });
    expect(rows[1]).toMatchObject({ ownerId: identity.userId });
    expect(rows[2]).toMatchObject({ plan: "free", periodUsed: 4 });
    expect(await t.run(ctx => ctx.db.query("billingCustomers").take(2))).toEqual([]);
  });

  test("repeated customer creation is one durable owner lock", async () => {
    const t = setup();
    await t.run(ctx => ctx.db.insert("users", { clerkUserId: identity.userId, updatedAt: 1 }));
    const refs = await Promise.all(Array.from({ length: 3 }, () => t.mutation(internal.billing.ensureCustomer, { mode: "test_mode", ...identity })));
    expect(new Set(refs).size).toBe(1);
    expect(await t.run(ctx => ctx.db.query("billingCustomers").take(3))).toHaveLength(1);
    await expect(t.mutation(internal.billing.ensureCustomer, {
      mode: "test_mode", ...identity, ownerTokenIdentifier: "https://other.synthetic|user_alice",
    })).rejects.toThrow("conflicts");
    await expect(t.mutation(internal.billing.ensureCustomer, {
      mode: "test_mode", ...identity, ownerTokenIdentifier: "https://clerk.synthetic|user_bob",
    })).rejects.toThrow("does not match");
  });

  test("provider customer IDs cannot cross owners or change after binding", async () => {
    const t = setup();
    const alice = await customer(t);
    const bob = await customer(t, "user_bob");
    const results = await Promise.allSettled([alice, bob].map(customerRef =>
      t.mutation(internal.billing.bindCustomer, { customerRef, customerId: "cus_shared" })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const bound = (await readCustomer(t, alice))?.customerId ? alice : bob;
    await expect(t.mutation(internal.billing.bindCustomer, { customerRef: bound, customerId: "cus_replacement" })).rejects.toThrow("conflicts");
    await t.mutation(internal.billing.bindCustomer, { customerRef: bound, customerId: "cus_shared" });
  });

  test.each(["absent", "deleted"])("%s users cannot create billing customers or reopen a late binding", async state => {
    const t = setup();
    await expect(t.mutation(internal.billing.ensureCustomer, { mode: "test_mode", ...identity })).rejects.toThrow("unavailable");
    const customerRef = await customer(t);
    await t.run(async ctx => {
      const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", identity.userId)).unique();
      if (state === "absent") await ctx.db.delete("users", user!._id);
      else await ctx.db.patch("users", user!._id, { deletedAt: 0 });
    });
    await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: "cus_deleted" });
    await expect(t.mutation(internal.billing.ensureCustomer, { mode: "test_mode", ...identity })).rejects.toThrow("unavailable");
    expect(await readCustomer(t, customerRef)).toMatchObject({ customerId: "cus_deleted", creationState: "preparing" });
    await expect(reserve(t, customerRef)).rejects.toThrow("unavailable");
  });

  test("a deleted user blocks checkout before its billing customer is tombstoned", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await t.run(async ctx => {
      const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", identity.userId)).unique();
      await ctx.db.patch("users", user!._id, { deletedAt: 0 });
    });
    expect((await readCustomer(t, customerRef))?.deletedAt).toBeUndefined();
    await expect(reserve(t, customerRef)).rejects.toThrow("unavailable");
    expect(await t.run(ctx => ctx.db.query("billingPurchases").take(1))).toEqual([]);
  });

  test.each([{ deletedAt: 0, generation: 1 }, { hold: true }])("a %o billing customer keeps a late ID without reopening or relinking", async state => {
    const t = setup();
    const alice = await customer(t);
    await t.run(ctx => ctx.db.patch("billingCustomers", alice, state));
    await expect(t.mutation(internal.billing.ensureCustomer, { mode: "test_mode", ...identity })).rejects.toThrow("unavailable");
    for (let i = 0; i < 2; i++) await t.mutation(internal.billing.bindCustomer, { customerRef: alice, customerId: "cus_late" });
    expect(await readCustomer(t, alice)).toMatchObject({ ...state, customerId: "cus_late", creationState: "preparing" });
    await expect(t.mutation(internal.billing.bindCustomer, { customerRef: alice, customerId: "cus_relinked" })).rejects.toThrow("conflicts");
    const bob = await customer(t, "user_bob");
    await expect(t.mutation(internal.billing.bindCustomer, { customerRef: bob, customerId: "cus_late" })).rejects.toThrow("conflicts");
    await expect(reserve(t, alice)).rejects.toThrow("unavailable");
  });

  test("ordinary user purge removes usage while retaining financial tombstones and receipts", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const purchaseRef = await reserve(t, customerRef);
    const eventRef = await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt });
    const subscriptionRef = await t.mutation(internal.billing.bindSubscription, { customerRef, mode, subscriptionId: "sub_retained", productId: terms.productId });
    await t.run(async ctx => {
      await ctx.db.patch("billingCustomers", customerRef, { deletedAt: 1, generation: 1 });
      await ctx.db.insert("creditAccounts", { userId: identity.userId, plan: "free", periodStartsAt: 1, periodUsed: 1, dayStartsAt: 1, dayUsed: 1 });
    });
    await t.mutation(internal.users.purgeUserData, { clerkUserId: identity.userId });
    expect(await readCustomer(t, customerRef)).toMatchObject({ deletedAt: 1, generation: 1 });
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).not.toBeNull();
    expect(await t.run(ctx => ctx.db.get("billingEvents", eventRef))).not.toBeNull();
    expect(await t.run(ctx => ctx.db.get("billingSubscriptions", subscriptionRef))).not.toBeNull();
    expect(await t.run(ctx => ctx.db.query("creditAccounts").take(2))).toEqual([]);
  });
});

describe("billing purchase and subscription bindings", () => {
  test("minimal rows omit optional IDs, amounts, periods and observations", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const purchaseRef = await reserve(t, customerRef);
    const subscriptionRef = await t.mutation(internal.billing.bindSubscription, { customerRef, mode, subscriptionId: "sub_synthetic", productId: terms.productId });
    const eventRef = await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt });
    const rows = await t.run(async ctx => ({
      purchase: await ctx.db.get("billingPurchases", purchaseRef),
      subscription: await ctx.db.get("billingSubscriptions", subscriptionRef),
      event: await ctx.db.get("billingEvents", eventRef),
    }));
    expect(rows.purchase).toMatchObject({ state: "preparing", terms });
    expect(rows.purchase).not.toHaveProperty("paymentId");
    expect(rows.purchase).not.toHaveProperty("principalMinor");
    expect(rows.subscription).toMatchObject({ customerRef, status: "pending" });
    expect(rows.subscription).not.toHaveProperty("serviceEnd");
    expect(rows.event).toMatchObject({ state: "pending", attempts: 0, generation: 0 });
    expect(rows.event).not.toHaveProperty("subscriptionId");
  });

  test("one pending checkout survives unknown outcome and elapsed expiry", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const attempts = await Promise.allSettled(["intent_a", "intent_b"].map(intentId => reserve(t, customerRef, intentId)));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const purchaseRef = (await readCustomer(t, customerRef))!.pendingPurchaseRef!;
    await t.run(ctx => ctx.db.patch("billingPurchases", purchaseRef, { state: "unknown", expiresAt: 1 }));
    await expect(reserve(t, customerRef, "intent_c")).rejects.toThrow("conflicts");
    expect(await t.run(ctx => ctx.db.query("billingPurchases").take(3))).toHaveLength(1);
  });

  test("an intent replay preserves all original catalog terms", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const purchaseRef = await reserve(t, customerRef);
    expect(await reserve(t, customerRef)).toBe(purchaseRef);
    for (const changed of [{ productId: "other" }, { quantity: 2 }, { credits: 4000 }, { catalogVersion: "v2" }, { sku: "top_up" as const }]) {
      await expect(t.mutation(internal.billing.reservePurchase, { customerRef, intentId: "intent_synthetic", terms: { ...terms, ...changed } })).rejects.toThrow("conflicts");
    }
    const bob = await readyCustomer(t, "user_bob");
    await expect(reserve(t, bob)).rejects.toThrow("conflicts");
    expect((await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef)))?.terms).toEqual(terms);
  });

  test("late bindings persist after deletion without reopening the purchase", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const purchaseRef = await reserve(t, customerRef);
    await t.run(async ctx => {
      await ctx.db.patch("billingCustomers", customerRef, { deletedAt: 1, generation: 1 });
      await ctx.db.patch("billingPurchases", purchaseRef, { state: "terminal" });
    });
    await t.mutation(internal.billing.bindSubscription, { customerRef, mode, subscriptionId: "sub_late", productId: terms.productId });
    await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, sessionId: "session_late", paymentId: "payment_late", subscriptionId: "sub_late", expiresAt: 2 });
    await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode });
    expect(await t.run(ctx => ctx.db.query("billingSubscriptions").take(2))).toMatchObject([{ subscriptionId: "sub_late", cancellationRecoveryRequired: true }]);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({
      state: "terminal", sessionId: "session_late", paymentId: "payment_late", subscriptionId: "sub_late", expiresAt: 2,
      cancellationRecoveryRequired: true, terms,
    });
    await expect(reserve(t, customerRef, "intent_after_delete")).rejects.toThrow("unavailable");
  });

  test("payment/session IDs are unique and binding changes roll back atomically", async () => {
    const t = setup();
    const alice = await readyCustomer(t);
    const bob = await readyCustomer(t, "user_bob");
    const purchaseRef = await reserve(t, alice);
    const bobPurchase = await reserve(t, bob, "bob_intent");
    await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, sessionId: "session_shared", paymentId: "payment_shared" });
    for (const ids of [{ sessionId: "session_shared" }, { paymentId: "payment_shared" }]) {
      await expect(t.mutation(internal.billing.bindPurchase, { purchaseRef: bobPurchase, mode, ...ids })).rejects.toThrow("conflicts");
    }
    await expect(t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, sessionId: "replacement", paymentId: "new_payment" })).rejects.toThrow("conflicts");
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ sessionId: "session_shared", paymentId: "payment_shared" });
    expect(await t.run(ctx => ctx.db.get("billingPurchases", bobPurchase))).not.toHaveProperty("paymentId");
  });

  test("subscriptions cannot change owner/product or attach to a foreign purchase", async () => {
    const t = setup();
    const alice = await readyCustomer(t);
    const bob = await readyCustomer(t, "user_bob");
    const args = { customerRef: alice, mode, subscriptionId: "sub_shared", productId: terms.productId };
    const subscriptionRef = await t.mutation(internal.billing.bindSubscription, args);
    expect(await t.mutation(internal.billing.bindSubscription, args)).toBe(subscriptionRef);
    await expect(t.mutation(internal.billing.bindSubscription, { ...args, customerRef: bob })).rejects.toThrow("conflicts");
    await expect(t.mutation(internal.billing.bindSubscription, { ...args, productId: "other" })).rejects.toThrow("conflicts");
    const purchaseRef = await reserve(t, bob, "intent_bob");
    await expect(t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, subscriptionId: "sub_shared" })).rejects.toThrow("conflicts");
    await expect(t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, subscriptionId: "sub_unknown" })).rejects.toThrow("conflicts");
  });
});

describe("billing receipts and shared revision fence", () => {
  test("repeated receipt duplicates insert once and advance the parent once", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const refs = await Promise.all(Array.from({ length: 4 }, () => t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt })));
    expect(new Set(refs).size).toBe(1);
    expect(await t.run(ctx => ctx.db.query("billingEvents").take(3))).toHaveLength(1);
    expect(await readCustomer(t, customerRef)).toMatchObject({ inputRevision: 1, unresolvedReceipts: 1 });
    const before = await t.run(ctx => ctx.db.get("billingEvents", refs[0]));
    await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt, paymentId: "metadata_cannot_rebind", eventType: "changed" });
    expect(await t.run(ctx => ctx.db.get("billingEvents", refs[0]))).toEqual(before);
  });

  test("changed proof quarantines without replacing the original digest or resources", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const eventRef = await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt, paymentId: "original_payment" });
    const changed = { customerRef, ...receipt, bodyDigest: "b".repeat(64), paymentId: "changed_payment" };
    expect(await t.mutation(internal.billing.recordReceipt, changed)).toBe(eventRef);
    await t.mutation(internal.billing.recordReceipt, changed);
    await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt });
    expect(await t.run(ctx => ctx.db.get("billingEvents", eventRef))).toMatchObject({
      state: "quarantined", bodyDigest: receipt.bodyDigest, paymentId: "original_payment",
    });
    expect(await readCustomer(t, customerRef)).toMatchObject({ inputRevision: 2, unresolvedReceipts: 1 });
    await expect(assertClean(t, customerRef)).rejects.toThrow("conflicts");
  });

  test("a collision after processing dirties the original customer, never the new association", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const bob = await readyCustomer(t, "user_bob");
    const eventRef = await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt });
    await t.run(async ctx => {
      await ctx.db.patch("billingEvents", eventRef, { state: "processed" });
      await ctx.db.patch("billingCustomers", customerRef, { unresolvedReceipts: 0 });
    });
    await t.mutation(internal.billing.recordReceipt, { customerRef: bob, ...receipt, bodyDigest: "b".repeat(64) });
    expect(await readCustomer(t, customerRef)).toMatchObject({ inputRevision: 2, unresolvedReceipts: 1 });
    expect(await readCustomer(t, bob)).toMatchObject({ inputRevision: 0, unresolvedReceipts: 0 });
  });

  test("mode isolates identical customer, subscription, payment, session and webhook IDs", async () => {
    const t = setup();
    for (const mode of ["test_mode", "live_mode"] as const) {
      const customerRef = await readyCustomer(t, identity.userId, mode);
      const purchaseRef = await reserve(t, customerRef);
      await t.mutation(internal.billing.bindSubscription, { customerRef, mode, subscriptionId: "sub_same", productId: terms.productId });
      await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode, paymentId: "payment_same", sessionId: "session_same", subscriptionId: "sub_same" });
      await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt, mode });
      expect(await readCustomer(t, customerRef)).toMatchObject({ mode, inputRevision: 1 });
    }
    expect(await t.run(ctx => ctx.db.query("billingEvents").take(3))).toHaveLength(2);
  });

  test("a verified receipt for an unmapped customer is kept quarantined and deduplicated", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const eventRef = await t.mutation(internal.billing.recordReceipt, { ...receipt, paymentId: "payment_unmapped" });
    expect(await t.mutation(internal.billing.recordReceipt, receipt)).toBe(eventRef);
    expect(await t.mutation(internal.billing.recordReceipt, { ...receipt, bodyDigest: "b".repeat(64) })).toBe(eventRef);
    const event = await t.run(ctx => ctx.db.get("billingEvents", eventRef));
    expect(event).toMatchObject({ mode, state: "quarantined", bodyDigest: receipt.bodyDigest, paymentId: "payment_unmapped" });
    expect(event).not.toHaveProperty("customerRef");
    expect(await readCustomer(t, customerRef)).toMatchObject({ inputRevision: 0, unresolvedReceipts: 0 });
    const liveRef = await t.mutation(internal.billing.recordReceipt, { ...receipt, mode: "live_mode" });
    expect(liveRef).not.toBe(eventRef);
    expect(await t.run(ctx => ctx.db.query("billingEvents").take(3))).toHaveLength(2);
  });

  test("an explicit mode must match the customer for receipts and bindings", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const purchaseRef = await reserve(t, customerRef);
    const other = "live_mode" as const;
    await expect(t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt, mode: other })).rejects.toThrow("conflicts");
    await expect(t.mutation(internal.billing.bindSubscription, { customerRef, mode: other, subscriptionId: "sub_x", productId: terms.productId })).rejects.toThrow("conflicts");
    await expect(t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: other, paymentId: "payment_x" })).rejects.toThrow("conflicts");
    expect(await t.run(ctx => ctx.db.query("billingEvents").take(1))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("billingSubscriptions").take(1))).toEqual([]);
    expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).not.toHaveProperty("paymentId");
  });

  test("unknown child association and deletion still dirty the parent coordinator", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await t.run(ctx => ctx.db.patch("billingCustomers", customerRef, { deletedAt: 1, generation: 3 }));
    const eventRef = await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt, subscriptionId: "unknown_child" });
    expect(await readCustomer(t, customerRef)).toMatchObject({ inputRevision: 1, unresolvedReceipts: 1, deletedAt: 1 });
    expect(await t.run(ctx => ctx.db.get("billingEvents", eventRef))).toMatchObject({ generation: 3, subscriptionId: "unknown_child" });
    await expect(assertClean(t, customerRef)).rejects.toThrow("unavailable");
  });

  test("positive commit guard rejects stale revision, generation, dirty receipts and holds", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const captured = await t.query(internal.billing.getFence, { customerRef });
    await assertClean(t, customerRef);
    await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt });
    await expect(t.run(ctx => assertBillingFence(ctx, customerRef, captured))).rejects.toThrow("conflicts");
    await expect(assertClean(t, customerRef)).rejects.toThrow("conflicts");
    await t.run(ctx => ctx.db.patch("billingCustomers", customerRef, { unresolvedReceipts: 0 }));
    const fresh = await t.query(internal.billing.getFence, { customerRef });
    await assertClean(t, customerRef);
    await t.run(ctx => ctx.db.patch("billingCustomers", customerRef, { generation: 1 }));
    await expect(t.run(ctx => assertBillingFence(ctx, customerRef, fresh))).rejects.toThrow("conflicts");
    await t.run(ctx => ctx.db.patch("billingCustomers", customerRef, { hold: true }));
    await expect(assertClean(t, customerRef)).rejects.toThrow("unavailable");
  });

  test("invalid normalized inputs fail before a durable write", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await expect(t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt, bodyDigest: "raw payload" })).rejects.toThrow("Invalid normalized");
    await expect(t.mutation(internal.billing.reservePurchase, { customerRef, intentId: "intent_bad", terms: { ...terms, quantity: NaN } })).rejects.toThrow("positive integers");
    await expect(t.mutation(internal.billing.bindCustomer, { customerRef, customerId: " " })).rejects.toThrow("nonempty");
    expect(await t.run(ctx => ctx.db.query("billingEvents").take(2))).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("billingPurchases").take(2))).toEqual([]);
  });
});
