// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const note = { operator: "support", reason: "Dashboard verified" };
async function setup() {
  const t = convexTest(schema, modules);
  const customerRef = await t.run(ctx => ctx.db.insert("billingCustomers", {
    mode: "test_mode", userId: "alice", ownerTokenIdentifier: "issuer|alice", creationState: "unknown",
    creationLeaseId: "old", creationLeasedAt: 1, generation: 0, inputRevision: 0, unresolvedReceipts: 0,
  }));
  return { t, customerRef };
}
afterEach(() => vi.restoreAllMocks());

test.each([undefined, "cus_verified"])("resolves an unknown customer with %s and stores the audit", async customerId => {
  const { t, customerRef } = await setup();
  await t.run(ctx => ctx.db.insert("users", { clerkUserId: "alice", updatedAt: 1 }));
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await t.mutation(internal.billingOperator.resolveUnknownCustomer, { customerRef, customerId, ...note });
  const row = await t.run(ctx => ctx.db.get(customerRef));
  expect(row).toMatchObject({ creationState: customerId ? "ready" : "preparing", resolution: { action: "resolveUnknownCustomer", ...note, at: expect.any(Number) } });
  expect(row?.creationLeaseId).toBeUndefined();
  expect(row?.creationLeasedAt).toBeUndefined();
  expect(row?.customerId).toBe(customerId);
  expect(JSON.stringify(log.mock.calls)).not.toContain(note.reason);
});

test.each(["ready", "preparing"] as const)("refuses a %s customer", async creationState => {
  const { t, customerRef } = await setup();
  await t.run(ctx => ctx.db.patch(customerRef, { creationState }));
  await expect(t.mutation(internal.billingOperator.resolveUnknownCustomer, { customerRef, ...note })).rejects.toThrow();
});

test("a provider id already bound to another owner conflicts without an audit or lease change", async () => {
  const { t, customerRef } = await setup();
  await t.run(ctx => ctx.db.insert("billingCustomers", { mode: "test_mode", userId: "bob", ownerTokenIdentifier: "issuer|bob", customerId: "cus_bob", creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0 }));
  await expect(t.mutation(internal.billingOperator.resolveUnknownCustomer, { customerRef, customerId: "cus_bob", ...note })).rejects.toThrow();
  expect(await t.run(ctx => ctx.db.get(customerRef))).toMatchObject({ creationState: "unknown", creationLeaseId: "old" });
});

test.each([
  { operator: "", reason: "ok" }, { operator: "a@b", reason: "ok" }, { operator: "a".repeat(65), reason: "ok" },
  { operator: "ok", reason: " " }, { operator: "ok", reason: "a".repeat(501) },
])("both overrides reject invalid audit fields %j", async fields => {
  const { t, customerRef } = await setup();
  for (const fn of [internal.billingOperator.resolveUnknownCustomer, internal.billingOperator.releaseCheckoutLock]) {
    await expect(t.mutation(fn, { customerRef, ...fields })).rejects.toThrow();
  }
});

test.each(["unknown", "open", "preparing", "terminal", "processing", "settled", "bound", "foreign", "mode"])("lock release validates and audits %s", async state => {
  const { t, customerRef } = await setup();
  const purchaseRef = await t.run(async ctx => {
    const other = await ctx.db.insert("billingCustomers", { mode: "test_mode", userId: "bob", ownerTokenIdentifier: "issuer|bob", creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0 });
    const ref = await ctx.db.insert("billingPurchases", {
      customerRef: state === "foreign" ? other : customerRef, mode: state === "mode" ? "live_mode" : "test_mode", intentId: "intent_1",
      state: ["bound", "foreign", "mode"].includes(state) ? "unknown" : state as "unknown",
      ...(state === "bound" ? { paymentId: "pay_1" } : {}), sessionId: "cks_1",
      terms: { sku: "top_up", productId: "pdt_topup", catalogVersion: "2026-11-17", quantity: 1, credits: 1000 },
    });
    await ctx.db.patch(customerRef, { pendingPurchaseRef: ref });
    return ref;
  });
  const call = () => t.mutation(internal.billingOperator.releaseCheckoutLock, { customerRef, ...note });
  if (["processing", "settled", "bound", "foreign", "mode"].includes(state)) {
    await expect(call()).rejects.toThrow();
    expect((await t.run(ctx => ctx.db.get(customerRef)))?.pendingPurchaseRef).toBe(purchaseRef);
    expect((await t.run(ctx => ctx.db.get(purchaseRef)))?.resolution).toBeUndefined();
  } else {
    await call();
    expect((await t.run(ctx => ctx.db.get(customerRef)))?.pendingPurchaseRef).toBeUndefined();
    expect(await t.run(ctx => ctx.db.get(purchaseRef))).toMatchObject({ state: "terminal", sessionId: "cks_1", resolution: { action: "releaseCheckoutLock", ...note, at: expect.any(Number) } });
    await expect(call()).rejects.toThrow();
  }
});
