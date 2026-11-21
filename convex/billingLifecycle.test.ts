// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
const modules = import.meta.glob("./**/*.ts");
const NOW = 1_800_000_000_000;
const KEY = "dummy-internal-key";
const mode = "test_mode" as const;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", KEY); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup() {
  const t = convexTest(schema, modules);
  const refs = await t.run(async ctx => {
    await ctx.db.insert("users", { clerkUserId: "alice", updatedAt: NOW });
    const customerRef = await ctx.db.insert("billingCustomers", { mode, userId: "alice", ownerTokenIdentifier: "dummy|alice",
      customerId: "cus_alice", creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0 });
    const subscriptionRef = await ctx.db.insert("billingSubscriptions", { customerRef, mode, subscriptionId: "sub_alice", productId: "pro_dummy",
      status: "active", paidThrough: NOW + 1000, serviceEnd: NOW + 1000, cancelAt: NOW + 1000, controlRenewable: true,
      cancellationRecoveryRequired: true });
    const lotRef = await ctx.db.insert("billingGrants", { customerRef, mode, userId: "alice", sourceKey: "dummy-period", kind: "current_period",
      quantity: 2000, consumed: 12, revoked: 0, expiresAt: NOW + 1000, serviceStart: NOW - 1000, serviceEnd: NOW + 1000 });
    await ctx.db.patch("billingCustomers", customerRef, { activeSubscriptionRef: subscriptionRef });
    return { customerRef, subscriptionRef, lotRef };
  });
  const alice = t.withIdentity({ subject: "alice", tokenIdentifier: "dummy|alice" });
  const prepare = (operation: "cancel" | "uncancel" = "cancel") => alice.mutation(api.billingLifecycle.prepareControl, { internalKey: KEY, mode, operation });
  const sub = () => t.run(ctx => ctx.db.get("billingSubscriptions", refs.subscriptionRef));
  const record = (revision: number, outcome: "confirmed" | "unknown" | "refused") => alice.mutation(api.billingLifecycle.recordControlResult,
    { internalKey: KEY, subscriptionRef: refs.subscriptionRef, revision, outcome });
  const canonical = (readStartedAt: number, scheduled: boolean, status = "active") => t.mutation(internal.billingFulfill.commitReconciliation, {
    customerRef: refs.customerRef, fence: { generation: 0, inputRevision: 0 }, receiptRefs: [], payments: [], subscriptions: [{
      subscriptionId: "sub_alice", customerId: "cus_alice", productId: "pro_dummy", status,
      cancelAtNextBillingDate: scheduled, readStartedAt, nextBillingAt: NOW + 500,
    }],
  });
  return { t, refs, alice, prepare, sub, record, canonical };
}
test("signed-out, wrong key, Bob and foreign token cannot claim Alice", async () => {
  const { t } = await setup();
  await expect(t.mutation(api.billingLifecycle.prepareControl, { internalKey: KEY, mode, operation: "cancel" })).rejects.toThrow();
  const alice = t.withIdentity({ subject: "alice", tokenIdentifier: "dummy|alice" });
  await expect(alice.mutation(api.billingLifecycle.prepareControl, { internalKey: "wrong", mode, operation: "cancel" })).rejects.toThrow();
  for (const operation of ["cancel", "uncancel"] as const) {
    for (const who of [{ subject: "bob", tokenIdentifier: "dummy|bob" }, { subject: "alice", tokenIdentifier: "foreign|alice" }]) {
      expect(await t.withIdentity(who).mutation(api.billingLifecycle.prepareControl, { internalKey: KEY, mode, operation }))
        .toMatchObject({ kind: "refused" });
    }
  }
});
test("claim serializes opposing controls, unknown remains pending even after time, refusal releases", async () => {
  const { prepare, record, sub } = await setup();
  expect(await prepare()).toMatchObject({ kind: "call", revision: 1 });
  expect(await prepare("uncancel")).toEqual({ kind: "refused", code: "control_pending" });
  await record(1, "unknown");
  vi.setSystemTime(NOW + 100_000);
  expect((await sub())?.controlPendingAt).toBe(NOW);
  await record(1, "refused");
  expect((await sub())?.controlPendingAt).toBeUndefined();
  expect(await prepare()).toMatchObject({ kind: "call", revision: 2 });
  await expect(record(1, "refused")).rejects.toThrow();
});
test.each(["confirmed", "unknown"] as const)("%s clears only after a post-claim canonical read; preserves money and recovery", async outcome => {
  const { t, refs, prepare, record, sub, canonical } = await setup();
  const lot = await t.run(ctx => ctx.db.get("billingGrants", refs.lotRef));
  await prepare(); await record(1, outcome);
  expect((await sub())?.controlPendingAt).toBe(NOW);
  await canonical(NOW - 1, true);
  expect((await sub())?.controlPendingAt).toBe(NOW);
  await canonical(NOW + 60_001, true, "cancelled");
  expect(await sub()).toMatchObject({ paidThrough: NOW + 1000, serviceEnd: NOW + 1000, cancelAt: NOW + 1000, cancellationRecoveryRequired: true });
  expect((await sub())?.controlPendingAt).toBeUndefined();
  expect(await t.run(ctx => ctx.db.get("billingGrants", refs.lotRef))).toEqual(lot);
  await canonical(NOW + 60_002, false);
  expect((await sub())?.cancelAt).toBeUndefined();
  expect((await sub())?.paidThrough).toBe(NOW + 1000);
});
test("uncancel at expiry, on customer hold, deleted, and nonrenewable is refused; cancel allowed on hold", async () => {
  for (const reason of ["expiry", "hold", "deleted", "nonrenewable", "mode"] as const) {
    const { t, refs, prepare } = await setup();
    if (reason === "expiry") vi.setSystemTime(NOW + 1000);
    await t.run(async ctx => {
      if (reason === "hold") await ctx.db.patch("billingCustomers", refs.customerRef, { hold: true });
      if (reason === "deleted") await ctx.db.patch("billingCustomers", refs.customerRef, { deletedAt: NOW });
      if (reason === "nonrenewable") await ctx.db.patch("billingSubscriptions", refs.subscriptionRef, { controlRenewable: false });
      if (reason === "mode") await ctx.db.patch("billingSubscriptions", refs.subscriptionRef, { mode: "live_mode" });
    });
    expect(await prepare("uncancel")).toMatchObject({ kind: "refused" });
    if (reason === "hold") expect(await prepare("cancel")).toMatchObject({ kind: "call" });
    vi.setSystemTime(NOW);
  }
});
test("Bob cannot record Alice result; deletion while uncancel pending never replays resume", async () => {
  const { t, refs, prepare, record, canonical, sub } = await setup();
  await prepare("uncancel");
  await expect(t.withIdentity({ subject: "bob" }).mutation(api.billingLifecycle.recordControlResult, {
    internalKey: KEY, subscriptionRef: refs.subscriptionRef, revision: 1, outcome: "refused",
  })).rejects.toThrow();
  await t.run(ctx => ctx.db.patch("billingCustomers", refs.customerRef, { deletedAt: NOW }));
  await record(1, "unknown");
  await canonical(NOW + 60_001, false);
  expect((await sub())?.controlOperation).toBeUndefined();
  expect(await prepare("uncancel")).toEqual({ kind: "refused", code: "unavailable" });
});

test("pre-write and in-flight canonical reads cannot release the dispatch window; a fresh post-window read can", async () => {
  const { prepare, sub, canonical, record } = await setup();
  expect(await prepare()).toMatchObject({ revision: 1, writeUntil: NOW + 60_000 });
  await canonical(NOW + 1, false); // Before dispatch/result.
  expect((await sub())?.controlPendingAt).toBe(NOW);
  expect(await prepare("uncancel")).toEqual({ kind: "refused", code: "control_pending" });
  vi.setSystemTime(NOW + 15_000);
  await record(1, "unknown");
  await canonical(NOW + 15_001, false); // A result alone cannot shorten the window.
  expect((await sub())?.controlPendingAt).toBe(NOW);
  await canonical(NOW + 60_000, false); // Strictly after the window, not at its boundary.
  expect((await sub())?.controlPendingAt).toBe(NOW);
  vi.setSystemTime(NOW + 60_001);
  expect(await prepare()).toEqual({ kind: "refused", code: "control_pending" }); // Time alone never clears.
  await canonical(NOW + 60_001, false);
  expect((await sub())?.controlPendingAt).toBeUndefined();
  expect(await prepare()).toMatchObject({ revision: 2 });
  await expect(record(1, "refused")).rejects.toThrow();
  expect((await sub())?.controlRevision).toBe(2);
});

test("a late result moves the fresh-read threshold beyond the write window", async () => {
  const { prepare, record, canonical, sub } = await setup();
  await prepare();
  vi.setSystemTime(NOW + 65_000);
  await record(1, "confirmed");
  await canonical(NOW + 61_000, false);
  expect((await sub())?.controlPendingAt).toBe(NOW);
  await canonical(NOW + 65_001, false);
  expect((await sub())?.controlPendingAt).toBeUndefined();
});

test("a deferred adapter PATCH and interleaved reconciliation cannot admit an opposing write", async () => {
  const { setDodoCancellation } = await import("../src/features/billing/server/dodo-subscription");
  const { prepare, canonical, record, sub } = await setup();
  await prepare();
  let finishPatch!: () => void;
  let dispatched!: () => void;
  const entered = new Promise<void>(resolve => { dispatched = resolve; });
  const blocked = new Promise<void>(resolve => { finishPatch = resolve; });
  const customer = { customer_id: "cus_alice", business_id: "bus_dummy" };
  const subscription = { subscription_id: "sub_alice", customer: { customer_id: "cus_alice" }, product_id: "pro_dummy",
    status: "active", cancel_at_next_billing_date: true };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(customer)).mockResolvedValueOnce(Response.json(subscription))
    .mockImplementationOnce(async () => { dispatched(); await blocked; return new Response(null); })
    .mockResolvedValueOnce(Response.json(customer)).mockResolvedValueOnce(Response.json(subscription));
  const pending = setDodoCancellation({ environment: "test_mode", apiKey: "dummy", businessId: "bus_dummy",
    proProductId: "pro_dummy", customerId: "cus_alice", controlWriteUntil: NOW + 60_000 },
  { subscriptionId: "sub_alice", timing: "period_end" }, fetchImpl);
  await entered;
  await canonical(NOW + 1, false);
  expect(await prepare("uncancel")).toEqual({ kind: "refused", code: "control_pending" });
  finishPatch();
  expect(await pending).toMatchObject({ kind: "confirmed" });
  await record(1, "confirmed");
  await canonical(NOW + 2, true);
  expect((await sub())?.controlPendingAt).toBe(NOW);
  await canonical(NOW + 60_001, true);
  expect((await sub())?.controlPendingAt).toBeUndefined();
});
