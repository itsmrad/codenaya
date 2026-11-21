// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, expect, test, vi } from "vitest";

import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { DELETION_BATCH } from "./billingDeletion";
import { addModelSpend } from "./modelSpend";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const KEY = "test-deletion-internal-key";
const NOW = Date.UTC(2026, 10, 21);
const ALICE = "user_alice";
const BOB = "user_bob";
const TERMS = { sku: "pro_monthly" as const, catalogVersion: "2026-11-17", productId: "pdt_pro", quantity: 1, credits: 2000 };
const setup = () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", KEY);
  return convexTest(schema, modules);
};
type T = ReturnType<typeof setup>;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
async function customer(t: T, mode: "test_mode" | "live_mode" = "test_mode", userId = ALICE) {
  return await t.run(async ctx => {
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique();
    if (!user) await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
    return await ctx.db.insert("billingCustomers", {
      mode, userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}`, creationState: "unknown",
      generation: 2, inputRevision: 3, unresolvedReceipts: 0,
    });
  });
}
const read = (t: T, ref: Id<"billingCustomers">) => t.run(ctx => ctx.db.get("billingCustomers", ref));
const alice = (t: T) => t.withIdentity({ subject: ALICE, tokenIdentifier: `https://clerk.synthetic|${ALICE}` });

test("signed Clerk deletion records both modes atomically; absent billing owners create no billing rows", async () => {
  const t = setup();
  const refs = [await customer(t), await customer(t, "live_mode")];
  const bob = await customer(t, "test_mode", BOB);
  const secret = `whsec_${btoa("dummy-clerk-signing-key")}`;
  vi.stubEnv("CLERK_WEBHOOK_SECRET", secret);
  const body = JSON.stringify({ type: "user.deleted", data: { id: ALICE, deleted: true, object: "user" } });
  const id = "msg_dummy_deletion", timestamp = new Date(NOW);
  const response = await t.fetch("/clerk-users-webhook", { method: "POST", body, headers: {
    "svix-id": id, "svix-timestamp": String(NOW / 1000), "svix-signature": new Webhook(secret).sign(id, timestamp, body),
  } });
  expect(response.status).toBe(200);
  for (const ref of refs) expect(await read(t, ref)).toMatchObject({
    deletedAt: NOW, hold: true, generation: 3, inputRevision: 4,
    cancellationRecoveryRequired: true, cancellationNextAttemptAt: NOW, cancellationLastOutcome: "pending",
  });
  expect((await read(t, bob))?.deletedAt).toBeUndefined();
  await t.mutation(internal.users.markDeleted, { clerkUserId: "user_missing" });
  await drain(t);
  expect(await t.run(ctx => ctx.db.query("billingCustomers").take(10))).toHaveLength(3);
  expect(await t.run(ctx => ctx.db.query("creditAccounts").take(10))).toEqual([]);
});

test("pages all historical resources without an active pointer; financial obligations survive purge", async () => {
  const t = setup(), ref = await customer(t);
  await t.run(async ctx => {
    for (let i = 0; i < DELETION_BATCH * 2 + 3; i++) {
      await ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode", intentId: `i_${i}`, terms: TERMS,
        state: i % 2 ? "processing" : "unknown" });
      await ctx.db.insert("billingSubscriptions", { customerRef: ref, mode: "test_mode", subscriptionId: `s_${i}`,
        productId: TERMS.productId, status: i % 2 ? "active" : "pending", paidThrough: NOW + 100, serviceEnd: NOW + 100 });
    }
  });
  const grant = await t.run(ctx => ctx.db.insert("billingGrants", { customerRef: ref, mode: "test_mode", userId: ALICE,
    sourceKey: "paid_before_delete", kind: "current_period", quantity: 2000, consumed: 50, revoked: 0,
    expiresAt: NOW + 100, serviceStart: NOW - 100, serviceEnd: NOW + 100 }));
  const originalGrant = await t.run(ctx => ctx.db.get("billingGrants", grant));
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  expect((await read(t, ref))?.cancellationRecoveryRequired).toBe(true);
  await drain(t);
  for (const table of ["billingPurchases", "billingSubscriptions"] as const) {
    const rows = await t.run(ctx => ctx.db.query(table).take(100));
    expect(rows).toHaveLength(43);
    expect(rows.every(r => r.cancellationRecoveryRequired)).toBe(true);
  }
  expect(await t.run(ctx => ctx.db.get("billingGrants", grant))).toEqual(originalGrant);
  expect((await read(t, ref))?.activeSubscriptionRef).toBeUndefined();
  expect(await t.run(ctx => ctx.db.query("billingSubscriptions").first())).toMatchObject({ paidThrough: NOW + 100, serviceEnd: NOW + 100 });
});

test.each(["support", "complete"] as const)("duplicate deletion preserves %s without new markers; new IDs reopen and fence", async outcome => {
  const t = setup(), ref = await customer(t);
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, {
    cancellationLastOutcome: outcome, cancellationRecoveryRequired: outcome !== "complete", cancellationAttempts: 7,
  }));
  vi.setSystemTime(NOW + 1000);
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  expect(await read(t, ref)).toMatchObject({ deletedAt: NOW, cancellationLastOutcome: outcome, cancellationAttempts: 7 });
  const revision = (await read(t, ref))!.inputRevision;
  await t.mutation(internal.billing.bindCustomer, { customerRef: ref, customerId: "cus_late" });
  expect(await read(t, ref)).toMatchObject({ customerId: "cus_late", deletedAt: NOW, hold: true,
    inputRevision: revision + 1, cancellationRecoveryRequired: true, cancellationLastOutcome: "pending", cancellationAttempts: 0 });
  await t.mutation(internal.billing.bindCustomer, { customerRef: ref, customerId: "cus_late" });
  expect((await read(t, ref))?.inputRevision).toBe(revision + 1);
});

test("delete between provider creates and recorders retains returned IDs; Bob cannot bind Alice", async () => {
  const t = setup(), ref = await customer(t);
  const purchase = await t.run(async ctx => {
    await ctx.db.patch("billingCustomers", ref, { creationState: "preparing", creationLeaseId: "lease" });
    const purchaseRef = await ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode", intentId: "intent", terms: TERMS, state: "preparing" });
    await ctx.db.patch("billingCustomers", ref, { pendingPurchaseRef: purchaseRef });
    return purchaseRef;
  });
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  await expect(t.withIdentity({ subject: BOB }).mutation(api.billingCheckout.recordCustomerResult,
    { internalKey: KEY, customerRef: ref, leaseId: "lease", result: { kind: "created", customerId: "cus_late" } })).rejects.toThrow();
  await alice(t).mutation(api.billingCheckout.recordCustomerResult,
    { internalKey: KEY, customerRef: ref, leaseId: "lease", result: { kind: "created", customerId: "cus_late" } });
  await alice(t).mutation(api.billingCheckout.recordCheckoutResult,
    { internalKey: KEY, purchaseRef: purchase, result: { kind: "created", sessionId: "cks_late" } });
  expect(await t.run(ctx => ctx.db.get("billingPurchases", purchase))).toMatchObject({ sessionId: "cks_late", cancellationRecoveryRequired: true });
  expect(await read(t, ref)).toMatchObject({ customerId: "cus_late", deletedAt: NOW, hold: true, cancellationLastOutcome: "pending" });
  await t.mutation(internal.billing.bindSubscription, { customerRef: ref, mode: "test_mode", subscriptionId: "sub_late", productId: TERMS.productId });
  expect(await t.run(ctx => ctx.db.query("billingSubscriptions").first())).toMatchObject({ subscriptionId: "sub_late", cancellationRecoveryRequired: true });
});

test("deleted payment and late subscription record evidence without grants or shrinking periods", async () => {
  const t = setup(), ref = await customer(t);
  await t.mutation(internal.billing.bindCustomer, { customerRef: ref, customerId: "cus_late" });
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  const commit = async () => {
    const c = (await read(t, ref))!;
    return await t.mutation(internal.billingFulfill.commitReconciliation, {
      customerRef: ref, fence: { generation: c.generation, inputRevision: c.inputRevision }, receiptRefs: [],
      payments: [{ paymentId: "pay_late", currency: "USD", totalMinor: 2000, taxMinor: 0,
        reversal: { kind: "known", refunds: [], disputes: [] },
        decision: { kind: "period", paymentId: "pay_late", subscriptionId: "sub_late", productId: TERMS.productId,
          credits: 2000, serviceStart: NOW, serviceEnd: NOW + 100, settledAt: NOW } }],
      subscriptions: [{ subscriptionId: "sub_late", customerId: "cus_late", productId: TERMS.productId,
        status: "active", cancelAtNextBillingDate: false }],
    });
  };
  await commit();
  expect(await t.run(ctx => ctx.db.query("billingPurchases").first())).toMatchObject({ paymentId: "pay_late", cancellationRecoveryRequired: true });
  expect(await t.run(ctx => ctx.db.query("billingSubscriptions").first())).toMatchObject({ subscriptionId: "sub_late", cancellationRecoveryRequired: true });
  await commit();
  expect(await t.run(ctx => ctx.db.query("billingGrants").take(10))).toEqual([]);
  expect(await t.run(ctx => ctx.db.query("creditAccounts").take(10))).toEqual([]);
});

test("post-purge transcription and run usage cannot recreate user accounts/spend; existing usage can still charge", async () => {
  const t = setup();
  await customer(t);
  const messageId = await t.run(async ctx => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: NOW });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: NOW });
    return await ctx.db.insert("messages", { conversationId, projectId, role: "assistant", content: "", status: "processing" });
  });
  await t.run(async ctx => {
    await ctx.db.insert("creditAccounts", { userId: ALICE, plan: "free", periodStartsAt: NOW, dayStartsAt: NOW, periodUsed: 0, dayUsed: 0 });
    await ctx.db.insert("platformCatalog", { updatedAt: NOW, updatedBy: "admin", defaultModelId: "limited", utilityModelId: "limited", models: [{
      id: "limited", name: "limited", vendor: "x", provider: "openrouter", providerModelId: "limited", vision: false, tools: "reported", access: "everyone", hidden: false,
      pricing: { mode: "blended", usdPerMTok: 1 }, spendLimit: { resets: "monthly", perUserUsd: 1 },
    }] });
    await addModelSpend(ctx, ALICE, "limited", 0.1, NOW);
  });
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  // Before purge, completed usage still charges existing rows.
  await t.mutation(api.credits.recordTranscriptionUsage, { internalKey: KEY, userId: ALICE, costUsd: 0.1 });
  await t.run(ctx => addModelSpend(ctx, ALICE, "limited", 0.1, NOW));
  expect(await t.run(ctx => ctx.db.query("creditAccounts").first())).toMatchObject({ periodUsed: 15 });
  await drain(t);
  await t.mutation(api.credits.recordTranscriptionUsage, { internalKey: KEY, userId: ALICE, costUsd: 0.1 });
  await t.mutation(api.credits.recordTranscriptionUsage, { internalKey: KEY, userId: "user_missing", costUsd: 0.1 });
  await t.run(ctx => addModelSpend(ctx, ALICE, "limited", 0.1, NOW));
  expect(await t.run(ctx => ctx.db.query("creditAccounts").take(10))).toEqual([]);
  await t.mutation(api.credits.recordRunUsage, { internalKey: KEY, messageId, source: "platform",
    inputTokens: 1, outputTokens: 1, costUsd: 0.1 });
  expect(await t.run(ctx => ctx.db.query("creditAccounts").take(10))).toEqual([]);
  const spend = await t.run(ctx => ctx.db.query("modelSpend").take(10));
  expect(spend.map(r => r.userId)).toEqual([null]);
  expect(spend[0].spentUsd).toBeCloseTo(0.3);
});

test("a remaining resource marker reopens complete, while duplicate support batches keep attempts", async () => {
  const t = setup(), ref = await customer(t);
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  await t.run(async ctx => {
    await ctx.db.patch("billingCustomers", ref, { cancellationLastOutcome: "complete", cancellationRecoveryRequired: false, cancellationAttempts: 8 });
    await ctx.db.insert("billingSubscriptions", { customerRef: ref, mode: "test_mode", subscriptionId: "sub_ended",
      productId: TERMS.productId, status: "cancelled", cancellationRecoveryRequired: true });
  });
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  expect(await read(t, ref)).toMatchObject({ deletedAt: NOW, cancellationLastOutcome: "pending", cancellationAttempts: 0 });
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, { cancellationLastOutcome: "support", cancellationAttempts: 8 }));
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  expect(await read(t, ref)).toMatchObject({ cancellationLastOutcome: "support", cancellationAttempts: 8 });
});

test("support billing holds do not prevent normal usage-account insertion", async () => {
  const t = setup(), ref = await customer(t);
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, { hold: true }));
  await t.mutation(api.credits.recordTranscriptionUsage, { internalKey: KEY, userId: ALICE, costUsd: 0.1 });
  expect(await t.run(ctx => ctx.db.query("creditAccounts").first())).toMatchObject({ userId: ALICE, periodUsed: 15 });
});

const recoverySnapshot = async (t: T, ref: Id<"billingCustomers">) => {
  const c = (await read(t, ref))!;
  return [c.generation, c.inputRevision, c.cancellationLastOutcome, c.cancellationAttempts, c.cancellationNextAttemptAt,
    c.leaseId, c.leaseExpiresAt];
};
async function completed(t: T, ref: Id<"billingCustomers">) {
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, { cancellationRecoveryRequired: false,
    cancellationLastOutcome: "complete", cancellationAttempts: 7, cancellationNextAttemptAt: NOW + 9000,
    leaseId: "live-receipt-lease", leaseExpiresAt: NOW + 60000 }));
}
const expectWake = async (t: T, ref: Id<"billingCustomers">, before: NonNullable<Awaited<ReturnType<typeof read>>>) => {
  expect(await read(t, ref)).toMatchObject({ generation: before.generation, inputRevision: before.inputRevision + 1,
    cancellationLastOutcome: "pending", cancellationRecoveryRequired: true, cancellationAttempts: 0,
    cancellationNextAttemptAt: NOW + 1000, leaseId: before.leaseId, leaseExpiresAt: before.leaseExpiresAt });
};

test("duplicate deletion preserves generation, revision, retry schedule and live receipt lease", async () => {
  const t = setup(), ref = await customer(t);
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  await completed(t, ref);
  const before = await recoverySnapshot(t, ref);
  vi.setSystemTime(NOW + 1000);
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  expect(await recoverySnapshot(t, ref)).toEqual(before);
});

test.each(["customer", "checkout"] as const)("deleted %s unknown and malformed-created results wake exactly once", async target => {
  for (const malformed of [false, true]) {
    const t = setup(), ref = await customer(t);
    const purchaseRef = await t.run(async ctx => {
      const purchase = await ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode", intentId: "unknown",
        terms: TERMS, state: "preparing" });
      await ctx.db.patch("billingCustomers", ref, { creationState: "preparing", creationLeaseId: "lease", pendingPurchaseRef: purchase });
      return purchase;
    });
    await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
    await drain(t);
    await completed(t, ref);
    vi.setSystemTime(NOW + 1000);
    const before = (await read(t, ref))!;
    const record = () => target === "customer"
      ? alice(t).mutation(api.billingCheckout.recordCustomerResult, { internalKey: KEY, customerRef: ref, leaseId: "lease",
        result: malformed ? { kind: "created", customerId: "invalid/id" } : { kind: "unknown" } })
      : alice(t).mutation(api.billingCheckout.recordCheckoutResult, { internalKey: KEY, purchaseRef,
        result: malformed ? { kind: "created", sessionId: "invalid/id" } : { kind: "unknown" } });
    await record();
    await expectWake(t, ref, before);
    const after = await recoverySnapshot(t, ref);
    await record();
    expect(await recoverySnapshot(t, ref)).toEqual(after);
  }
});

test("late binding wakes live-lease recovery, but identical IDs after completion do not", async () => {
  const t = setup(), ref = await customer(t);
  const purchaseRef = await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode", intentId: "late",
    terms: TERMS, state: "open" }));
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  await completed(t, ref);
  vi.setSystemTime(NOW + 1000);
  let before = (await read(t, ref))!;
  await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", paymentId: "pay_late" });
  await expectWake(t, ref, before);
  await completed(t, ref);
  before = (await read(t, ref))!;
  await t.mutation(internal.billing.bindSubscription, { customerRef: ref, mode: "test_mode", subscriptionId: "sub_new", productId: TERMS.productId });
  await expectWake(t, ref, before);
  await t.run(async ctx => {
    await ctx.db.patch("billingPurchases", purchaseRef, { state: "terminal", cancellationRecoveryRequired: false });
    const row = await ctx.db.query("billingSubscriptions").first();
    await ctx.db.patch("billingSubscriptions", row!._id, { status: "cancelled", cancellationRecoveryRequired: false });
  });
  await completed(t, ref);
  const snapshot = await recoverySnapshot(t, ref);
  await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", paymentId: "pay_late" });
  await t.mutation(internal.billing.bindSubscription, { customerRef: ref, mode: "test_mode", subscriptionId: "sub_new", productId: TERMS.productId });
  expect(await recoverySnapshot(t, ref)).toEqual(snapshot);
});

test("processing transition wakes once; known-ended subscription replay preserves completion", async () => {
  const t = setup(), ref = await customer(t);
  await t.run(async ctx => {
    await ctx.db.patch("billingCustomers", ref, { customerId: "cus_late" });
    await ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode", intentId: "processing",
      terms: TERMS, paymentId: "pay_processing", state: "open" });
    await ctx.db.insert("billingSubscriptions", { customerRef: ref, mode: "test_mode", subscriptionId: "sub_ended",
      productId: TERMS.productId, status: "cancelled" });
  });
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  await completed(t, ref);
  vi.setSystemTime(NOW + 1000);
  const commit = async (processing: boolean) => {
    const c = (await read(t, ref))!;
    return await t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: ref,
      fence: { generation: c.generation, inputRevision: c.inputRevision }, receiptRefs: [],
      payments: processing ? [{ paymentId: "pay_processing", decision: { kind: "processing", paymentId: "pay_processing" },
        reversal: { kind: "unknown", reason: "missing" } }] : [],
      subscriptions: [{ subscriptionId: "sub_ended", customerId: "cus_late", productId: TERMS.productId,
        status: "cancelled", cancelAtNextBillingDate: false }],
    });
  };
  const before = (await read(t, ref))!;
  await commit(true);
  await expectWake(t, ref, before);
  await completed(t, ref);
  const after = await recoverySnapshot(t, ref);
  await commit(true);
  await commit(false);
  expect(await recoverySnapshot(t, ref)).toEqual(after);
});

test("settled payment replay does not reopen a completed obligation", async () => {
  const t = setup(), ref = await customer(t);
  await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });
  await drain(t);
  const purchase = await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode", intentId: "settled",
    terms: { ...TERMS, sku: "top_up" }, paymentId: "pay_settled", state: "settled", cancellationRecoveryRequired: false }));
  await completed(t, ref);
  const before = await recoverySnapshot(t, ref), c = (await read(t, ref))!;
  await t.mutation(internal.billingFulfill.commitReconciliation, { customerRef: ref,
    fence: { generation: c.generation, inputRevision: c.inputRevision }, receiptRefs: [], subscriptions: [],
    payments: [{ paymentId: "pay_settled", decision: { kind: "top_up", paymentId: "pay_settled", productId: TERMS.productId,
      credits: 2000, settledAt: NOW }, reversal: { kind: "unknown", reason: "missing" } }],
  });
  expect(await recoverySnapshot(t, ref)).toEqual(before);
  expect((await t.run(ctx => ctx.db.get("billingPurchases", purchase)))?.cancellationRecoveryRequired).toBe(false);
});
