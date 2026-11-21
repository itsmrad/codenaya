// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { RETENTION_BATCH, RETENTION_DELETE_BATCH } from "./billingRetention";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DELETED = Date.UTC(2025, 7, 31, 12);
const NOW = Date.UTC(2027, 1, 28, 12);
const TERMS = { sku: "pro_monthly" as const, catalogVersion: "2026-11-17", productId: "pdt_dummy", quantity: 1, credits: 2000 };
const setup = () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  return convexTest(schema, modules);
};
type T = ReturnType<typeof setup>;
afterEach(() => vi.useRealTimers());
const purge = (t: T) => t.mutation(internal.billingRetention.purgeExpiredBillingCustomers, { cursor: null });
const read = (t: T, ref: Id<"billingCustomers">) => t.run(ctx => ctx.db.get("billingCustomers", ref));
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
async function seed(t: T, suffix = "alice") {
  return t.run(async ctx => {
    await ctx.db.insert("users", { clerkUserId: suffix, deletedAt: DELETED, updatedAt: DELETED });
    return ctx.db.insert("billingCustomers", {
      mode: "test_mode", userId: suffix, ownerTokenIdentifier: `dummy|${suffix}`, customerId: `cus_${suffix}`,
      creationState: "ready", deletedAt: DELETED, hold: true, generation: 1, inputRevision: 1,
      unresolvedReceipts: 0, cancellationRecoveryRequired: false, cancellationLastOutcome: "complete",
    });
  });
}
async function event(t: T, ref: Id<"billingCustomers">, state: Doc<"billingEvents">["state"]) {
  return t.run(ctx => ctx.db.insert("billingEvents", { customerRef: ref, mode: "test_mode", webhookId: "evt_dummy",
    eventType: "payment.succeeded", paymentId: "pay_dummy", occurredAt: 1, receivedAt: 1, bodyDigest: "a".repeat(64),
    state, attempts: 0, nextAttemptAt: 1, generation: 1 }));
}
async function subscription(t: T, ref: Id<"billingCustomers">, patch: Partial<Doc<"billingSubscriptions">> = {}) {
  return t.run(ctx => ctx.db.insert("billingSubscriptions", { customerRef: ref, mode: "test_mode",
    subscriptionId: "sub_dummy", productId: "pdt_dummy", status: "cancelled", ...patch }));
}
async function purchase(t: T, ref: Id<"billingCustomers">, patch: Partial<Doc<"billingPurchases">> = {}) {
  return t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode: "test_mode",
    intentId: "intent_dummy", terms: TERMS, state: "terminal", ...patch }));
}
async function grants(t: T, ref: Id<"billingCustomers">, count: number) {
  await t.run(async ctx => {
    for (let i = 0; i < count; i++) await ctx.db.insert("billingGrants", { customerRef: ref, mode: "test_mode",
      userId: "alice", sourceKey: `lot_${i}`, kind: "top_up", quantity: 1000, consumed: 0, revoked: 0, expiresAt: 1 });
  });
}

test("exact retention boundary; leaves the users tombstone", async () => {
  const t = setup(), ref = await seed(t);
  vi.setSystemTime(NOW - 1); await purge(t); expect(await read(t, ref)).not.toBeNull();
  vi.setSystemTime(NOW); await purge(t); expect(await read(t, ref)).toBeNull();
  expect(await t.run(ctx => ctx.db.query("users").first())).toMatchObject({ deletedAt: DELETED });
});

const customerBlockers: Partial<Doc<"billingCustomers">>[] = [
  { deletedAt: undefined }, { deletedAt: NOW },
  { cancellationRecoveryRequired: undefined }, { cancellationRecoveryRequired: true },
  { cancellationLastOutcome: undefined }, { cancellationLastOutcome: "pending" },
  { cancellationLastOutcome: "retry" }, { cancellationLastOutcome: "support" },
  { unresolvedReceipts: 1 }, { watchUntil: NOW + 1 },
  { leaseExpiresAt: NOW + 1 }, { cancellationLeaseExpiresAt: NOW + 1 },
  { leaseId: "lease_dummy" }, { cancellationLeaseId: "cancel_dummy" },
  { customerId: undefined }, { creationState: "preparing" }, { creationState: "unknown" }, { creationLeaseId: "create_dummy" },
  { cancellationProgress: { generation: 1, inputRevision: 1, until: 1, phase: "payments", page: 0, offset: 0, cursor: null, blocked: false } },
  { cancellationProgress: { generation: 1, inputRevision: 1, until: 1, phase: "done", page: 0, offset: 0, cursor: null, blocked: true } },
];
test.each(customerBlockers)("customer blocker skips without deleting children: %j", async patch => {
  const t = setup(), ref = await seed(t); await grants(t, ref, 1);
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, patch)); await purge(t);
  expect(await read(t, ref)).not.toBeNull();
  expect(await t.run(ctx => ctx.db.query("billingGrants").first())).not.toBeNull();
});

test.each(["preparing", "unknown", "open", "processing"] as const)("purchase %s blocks", async state => {
  const t = setup(), ref = await seed(t); await purchase(t, ref, { state });
  await purge(t); expect(await read(t, ref)).not.toBeNull();
});
test.each(["pending", "processing", "quarantined"] as const)("actual %s receipt blocks even with zero counter", async state => {
  const t = setup(), ref = await seed(t); await event(t, ref, state);
  await purge(t); expect(await read(t, ref)).not.toBeNull();
});
test.each(["purchase", "subscription", "controlTime", "cancel", "uncancel", "hold", "pending", "review", "other"])("resource blocker: %s", async blocker => {
  const t = setup(), ref = await seed(t); await grants(t, ref, 1);
  if (blocker === "purchase") await purchase(t, ref, { cancellationRecoveryRequired: true });
  else if (blocker === "subscription") await subscription(t, ref, { cancellationRecoveryRequired: true });
  else if (blocker === "controlTime") await subscription(t, ref, { controlPendingAt: 0 });
  else if (blocker === "cancel" || blocker === "uncancel") await subscription(t, ref, { controlOperation: blocker });
  else await t.run(ctx => ctx.db.insert("billingAdjustments", { customerRef: ref, mode: "test_mode", paymentId: "pay_dummy",
    kind: blocker === "hold" ? "support_hold" : "refund", providerId: "hold_dummy", status: blocker === "hold" ? "open" : blocker, countedMinor: 0, holdActive: blocker === "hold", observedAt: 1 }));
  await purge(t); expect(await read(t, ref)).not.toBeNull();
  expect(await t.run(ctx => ctx.db.query("billingGrants").first())).not.toBeNull();
});

test("pages customers past the batch, including skipped customers", async () => {
  const t = setup();
  const blocked = await seed(t, "blocked");
  await t.run(ctx => ctx.db.patch("billingCustomers", blocked, { cancellationRecoveryRequired: true }));
  for (let i = 0; i < RETENTION_BATCH + 2; i++) await seed(t, `customer_${i}`);
  await purge(t); await drain(t);
  expect(await t.run(ctx => ctx.db.query("billingCustomers").take(20))).toEqual([expect.objectContaining({ _id: blocked })]);
});

test("bounded child-first crash resume rechecks late blockers; customer last", async () => {
  const t = setup(), ref = await seed(t);
  await grants(t, ref, RETENTION_DELETE_BATCH + 2);
  const ev = await event(t, ref, "processed"), p = await purchase(t, ref), s = await subscription(t, ref);
  await t.run(ctx => ctx.db.insert("billingAdjustments", { customerRef: ref, mode: "test_mode", paymentId: "pay_dummy",
    kind: "refund", providerId: "ref_dummy", status: "succeeded", countedMinor: 100, holdActive: false, observedAt: 1 }));
  await purge(t);
  expect(await t.run(ctx => ctx.db.query("billingGrants").take(10))).toHaveLength(2);
  for (const id of [ev, p, s]) expect(await t.run(ctx => ctx.db.get(id))).not.toBeNull();
  expect(await read(t, ref)).not.toBeNull();
  // Simulate a lost continuation: a fresh daily invocation resumes from the surviving customer.
  await t.run(ctx => ctx.db.patch("billingEvents", ev, { state: "quarantined" }));
  await purge(t); expect(await read(t, ref)).not.toBeNull();
  expect(await t.run(ctx => ctx.db.query("billingGrants").take(10))).toHaveLength(2);
  await t.run(ctx => ctx.db.patch("billingEvents", ev, { state: "processed" }));
  await purge(t); await drain(t); expect(await read(t, ref)).toBeNull();
  for (const table of ["billingGrants", "billingAdjustments", "billingEvents", "billingPurchases", "billingSubscriptions"] as const)
    expect(await t.run(ctx => ctx.db.query(table).first())).toBeNull();
});

test("expired leases/watch permit purge; late/replayed receipts quarantine without grants or rebinding", async () => {
  const t = setup(), ref = await seed(t);
  await purchase(t, ref, { paymentId: "pay_dummy" });
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, { leaseExpiresAt: NOW, cancellationLeaseExpiresAt: NOW, watchUntil: NOW }));
  await purge(t);
  for (const providerCustomerId of ["cus_alice", undefined]) {
    const args = { mode: "test_mode" as const, webhookId: `late_${providerCustomerId ?? "payment"}`, providerCustomerId,
      paymentId: "pay_dummy", eventType: "payment.succeeded", bodyDigest: "a".repeat(64), occurredAt: NOW };
    const ev = await t.mutation(internal.billing.recordReceipt, args);
    expect(await t.mutation(internal.billing.recordReceipt, args)).toBe(ev);
    expect(await t.run(ctx => ctx.db.get("billingEvents", ev))).toMatchObject({ state: "quarantined", quarantineReason: "unmapped" });
  }
  await drain(t);
  expect(await t.run(ctx => ctx.db.query("billingCustomers").first())).toBeNull();
  expect(await t.run(ctx => ctx.db.query("billingGrants").first())).toBeNull();
  expect(await t.run(ctx => ctx.db.query("creditAccounts").first())).toBeNull();
});

test("pending checkout pointer blocks even without a remaining purchase", async () => {
  const t = setup(), ref = await seed(t), p = await purchase(t, ref);
  await t.run(async ctx => {
    await ctx.db.delete("billingPurchases", p);
    await ctx.db.patch("billingCustomers", ref, { pendingPurchaseRef: p });
  });
  await purge(t); expect(await read(t, ref)).not.toBeNull();
});
