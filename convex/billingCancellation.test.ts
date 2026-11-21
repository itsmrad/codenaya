// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CANCELLATION_LEASE_MS, CANCELLATION_MAX_ATTEMPTS, CANCELLATION_MAX_DELAY_MS, CANCELLATION_FETCH_LIMIT } from "./billingCancellation";
import { PROVIDER_CLOCK_SKEW_MS } from "./billingPoll";
import { queueDeletionRecovery } from "./billingDeletion";
import schema from "./schema";
import { sha256Hex } from "./billingWebhook";

const modules = import.meta.glob("./**/*.ts");
const NOW = Date.UTC(2026, 10, 21);
const mode = "test_mode" as const;
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  for (const [key, value] of Object.entries({ CODENAYA_DEPLOYMENT: "development", DODO_PAYMENTS_ENVIRONMENT: mode,
    DODO_PAYMENTS_BUSINESS_ID: "bus_dummy", DODO_PAYMENTS_API_KEY: "sk_dummy_canary", DODO_PAYMENTS_PRO_PRODUCT_ID: "pdt_pro",
    DODO_PAYMENTS_TOP_UP_PRODUCT_ID: "pdt_top", CODENAYA_BILLING_ENABLED: "false" })) vi.stubEnv(key, value);
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;
async function customer(t: T, extra = {}) {
  return t.run(ctx => ctx.db.insert("billingCustomers", { mode, ownerTokenIdentifier: "dummy|alice", userId: "alice",
    customerId: "cus_dummy", creationState: "ready", deletedAt: NOW - 1, hold: true,
    generation: 1, inputRevision: 0, unresolvedReceipts: 0, cancellationRecoveryRequired: true,
    cancellationLastOutcome: "pending", cancellationNextAttemptAt: NOW, ...extra }));
}
async function row(t: T, ref: Id<"billingCustomers">) { return t.run(ctx => ctx.db.get("billingCustomers", ref)); }
async function claim(t: T, ref: Id<"billingCustomers">) {
  const result = await t.mutation(internal.billingCancellation.claimCancellation, { customerRef: ref });
  if (!result) throw new Error("Expected claim");
  return result;
}
async function commit(t: T, ref: Id<"billingCustomers">, c: Awaited<ReturnType<typeof claim>>, phase = c.progress.phase) {
  return t.mutation(internal.billingCancellation.commitCancellationEvidence, { customerRef: ref, generation: c.generation,
    inputRevision: c.inputRevision, leaseId: c.leaseId, evidence: { progress: { ...c.progress, phase }, failed: false,
      support: false, retryAt: 0, ended: [], resolved: [], findings: [] } });
}
function provider(opts: { full?: boolean; failure?: number; retryAfter?: string; processing?: boolean; renewable?: boolean; succeededAt?: number; listPayment?: boolean } = {}) {
  const cancelled = new Set<string>();
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const id = url.pathname.split("/")[2];
    if (init?.method === "PATCH") cancelled.add(id);
    if (opts.failure) return new Response("{}", { status: opts.failure, headers: { "retry-after": opts.retryAfter ?? "86400" } });
    let body: object = { items: [] };
    if (url.pathname.startsWith("/customers/")) body = { customer_id: "cus_dummy", business_id: "bus_dummy" };
    else if (url.pathname.startsWith("/checkouts/")) body = { id, created_at: new Date(NOW - 3 * 86400000).toISOString(),
      payment_id: opts.processing ? "pay_dummy" : null, payment_status: opts.processing ? "processing" : null };
    else if (url.pathname.startsWith("/payments/")) body = { payment_id: id, business_id: "bus_dummy", customer: { customer_id: "cus_dummy" },
      created_at: new Date(opts.succeededAt ?? NOW).toISOString(), status: opts.succeededAt === undefined ? "processing" : "succeeded", total_amount: 100, currency: "USD", product_cart: [] };
    else if (url.pathname.startsWith("/subscriptions/")) body = { subscription_id: id, customer: { customer_id: "cus_dummy" }, product_id: "pdt_pro",
      status: cancelled.has(id) ? "cancelled" : opts.renewable ? "paused" : "cancelled", cancel_at_next_billing_date: false };
    else if (url.pathname === "/payments" && opts.listPayment) body = { items: [{ payment_id: "pay_dummy", status: "succeeded",
      customer: { customer_id: "cus_dummy" }, created_at: new Date(opts.succeededAt ?? NOW).toISOString() }] };
    else if (url.pathname === "/subscriptions" && opts.full && url.searchParams.get("page_number") === "0") body = { items: Array.from({ length: 20 }, (_, i) => ({
      subscription_id: `sub_${i}`, status: "cancelled", customer: { customer_id: "cus_dummy" }, created_at: new Date(NOW - 1000).toISOString() })) };
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fn); return fn;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("empty discovery and known resources complete only after all four phases, even checkout disabled", async () => {
  const t = setup(), ref = await customer(t); const fetchMock = provider();
  for (let i = 0; i < 4; i++) await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: false, cancellationLastOutcome: "complete", hold: true });
  expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
});

test("new evidence fences live claim, retains lease, and resets stale progress after expiry", async () => {
  const t = setup(), ref = await customer(t); const c = await claim(t, ref);
  await t.run(ctx => queueDeletionRecovery(ctx, ref));
  expect(await commit(t, ref, c)).toBe("stale");
  expect(await t.mutation(internal.billingCancellation.claimCancellation, { customerRef: ref })).toBeNull();
  vi.setSystemTime(NOW + CANCELLATION_LEASE_MS + 1);
  const next = await claim(t, ref);
  expect(next.leaseId).not.toBe(c.leaseId); expect(next.progress.phase).toBe("subscriptions"); expect(next.inputRevision).toBe(c.inputRevision + 1);
});

test("expired worker cannot commit after crash reclamation; repeated crashes exhaust to support", async () => {
  const t = setup(), ref = await customer(t); const c = await claim(t, ref);
  vi.setSystemTime(NOW + CANCELLATION_LEASE_MS + 1); await claim(t, ref);
  expect(await commit(t, ref, c)).toBe("stale");
  for (let i = 2; i < CANCELLATION_MAX_ATTEMPTS; i++) { vi.setSystemTime(NOW + i * (CANCELLATION_LEASE_MS + 1)); await claim(t, ref); }
  vi.setSystemTime(NOW + (CANCELLATION_MAX_ATTEMPTS + 1) * CANCELLATION_LEASE_MS);
  expect(await t.mutation(internal.billingCancellation.claimCancellation, { customerRef: ref })).toBeNull();
  expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationLastOutcome: "support" });
});

test.each([429, 503])("provider %s respects retry-after and never completes", async status => {
  const t = setup(), ref = await customer(t); provider({ failure: status });
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationLastOutcome: "retry" });
  expect((await row(t, ref))!.cancellationNextAttemptAt).toBeGreaterThanOrEqual(NOW + CANCELLATION_MAX_DELAY_MS);
});

test("missing customer ID and unresolved customer creation with empty lists require support", async () => {
  const t = setup(); const fetchMock = provider();
  for (const extra of [{ customerId: undefined, creationState: "unknown" as const }, { customerId: undefined, creationState: "preparing" as const }]) {
    const ref = await customer(t, extra); await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
    expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationLastOutcome: "support" });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("full page persists offset; it never infers an empty remainder or exceeds nested fetch budget", async () => {
  const t = setup(), ref = await customer(t); const fetchMock = provider({ full: true });
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(CANCELLATION_FETCH_LIMIT);
  // New synthetic receipts intentionally invalidate the current proof and force a fresh pass.
  expect((await row(t, ref))!.cancellationRecoveryRequired).toBe(true);
  expect((await row(t, ref))!.cancellationProgress!.phase).toBe("subscriptions");
});

test("commit refuses skipping discovery, and incomplete local purchase proof cannot complete", async () => {
  const t = setup(), ref = await customer(t); const c = await claim(t, ref);
  expect(await commit(t, ref, c, "done")).toBe("stale");
  await t.run(async ctx => {
    await ctx.db.patch("billingCustomers", ref, { cancellationLeaseExpiresAt: 0,
      cancellationProgress: { ...c.progress, phase: "purchases" } });
    await ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "intent_dummy", state: "unknown", cancellationRecoveryRequired: true,
      terms: { sku: "top_up", catalogVersion: "dummy", productId: "pdt_top", quantity: 1, credits: 1000 } });
  });
  expect(await commit(t, ref, await claim(t, ref), "done")).toBe("pending");
  expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationLastOutcome: "retry" });
});

test("cancelled known subscription plus expired checkout with processing payment stays incomplete and preserves periods", async () => {
  const t = setup(), ref = await customer(t); provider({ processing: true });
  const sub = await t.run(ctx => ctx.db.insert("billingSubscriptions", { customerRef: ref, mode, subscriptionId: "sub_known", productId: "pdt_pro",
    status: "cancelled", paidThrough: NOW + 10000, serviceEnd: NOW + 10000, cancellationRecoveryRequired: true }));
  await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "intent_dummy", state: "terminal", sessionId: "cks_dummy",
    cancellationRecoveryRequired: true, terms: { sku: "top_up", catalogVersion: "dummy", productId: "pdt_top", quantity: 1, credits: 1000 } }));
  // Known-subscription receipt forces restart once; subsequent passes use the same dedupe key.
  for (let i = 0; i < 9; i++) { vi.setSystemTime(NOW + i * (CANCELLATION_LEASE_MS + 1)); await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref }); }
  expect((await row(t, ref))!.cancellationRecoveryRequired).toBe(true);
  expect(await t.run(ctx => ctx.db.get("billingSubscriptions", sub))).toMatchObject({ paidThrough: NOW + 10000, serviceEnd: NOW + 10000 });
});

test("late obligation reopens completed recovery and resets retry budget", async () => {
  const t = setup(), ref = await customer(t, { cancellationRecoveryRequired: false, cancellationLastOutcome: "complete", cancellationAttempts: 8 });
  await t.run(ctx => queueDeletionRecovery(ctx, ref));
  expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationLastOutcome: "pending", cancellationAttempts: 0, inputRevision: 1 });
});


test("full discovery page advances across chunks, including old subscriptions missed by local pointers", async () => {
  const t = setup(), ref = await customer(t); const fetchMock = provider({ full: true });
  // Existing canonical receipts keep the discovery pass stable so this isolates its page/offset contract.
  for (let i = 0; i < 20; i++) {
    const key = `poll:subscription:sub_${i}:cancelled`;
    await t.mutation(internal.billing.recordReceipt, { customerRef: ref, mode, webhookId: key, eventType: "subscription.poll",
      subscriptionId: `sub_${i}`, bodyDigest: await sha256Hex(new TextEncoder().encode(key)), occurredAt: NOW, ignored: true });
  }
  for (let i = 0; i < 7; i++) {
    fetchMock.mockClear();
    await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(CANCELLATION_FETCH_LIMIT);
    expect((await row(t, ref))!.cancellationRecoveryRequired).toBe(true);
  }
  expect((await row(t, ref))!.cancellationProgress).toMatchObject({ phase: "subscriptions", page: 1, offset: 0 });
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect((await row(t, ref))!.cancellationProgress!.phase).toBe("knownSubscriptions");
});

test("three renewable subscriptions use exactly twenty nested requests, cancel immediately, and never resume", async () => {
  const t = setup(), ref = await customer(t); const fetchMock = provider({ full: true, renewable: true });
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(fetchMock.mock.calls).toHaveLength(CANCELLATION_FETCH_LIMIT);
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(writes).toHaveLength(3);
  for (const [, init] of writes) expect(JSON.parse(String(init!.body))).toEqual({ status: "cancelled" });
});


test("a failed bound payment cannot prove a still-open session expired", async () => {
  const t = setup(), ref = await customer(t); const base = provider();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/checkouts/")) return new Response(JSON.stringify({ id: "cks_live", created_at: new Date(NOW).toISOString(),
      payment_id: "pay_failed", payment_status: "failed" }));
    if (path.startsWith("/payments/")) return new Response(JSON.stringify({ payment_id: "pay_failed", business_id: "bus_dummy",
      customer: { customer_id: "cus_dummy" }, status: "failed", created_at: new Date(NOW).toISOString(), total_amount: 100, currency: "USD", product_cart: [] }));
    return base(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "intent_live", state: "terminal",
    sessionId: "cks_live", paymentId: "pay_failed", cancellationRecoveryRequired: true,
    terms: { sku: "top_up", catalogVersion: "dummy", productId: "pdt_top", quantity: 1, credits: 1000 } }));
  for (let i = 0; i < 9; i++) { vi.setSystemTime(NOW + i * (CANCELLATION_LEASE_MS + 1)); await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref }); }
  expect((await row(t, ref))!.cancellationRecoveryRequired).toBe(true);
});

async function phase(t: T, ref: Id<"billingCustomers">, value: "payments" | "purchases" | "knownSubscriptions") {
  const c = await claim(t, ref);
  await t.run(ctx => ctx.db.patch("billingCustomers", ref, { cancellationLeaseExpiresAt: 0,
    cancellationProgress: { ...c.progress, phase: value } }));
}
const terms = { sku: "top_up" as const, catalogVersion: "dummy", productId: "pdt_top", quantity: 1, credits: 1000 };

test.each(["payments", "purchases"] as const)("late succeeded charge in %s requires support even when locally settled", async value => {
  const t = setup(), ref = await customer(t);
  provider({ succeededAt: NOW - PROVIDER_CLOCK_SKEW_MS, listPayment: value === "payments" });
  const purchaseRef = await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "late_charge",
    state: "settled", paymentId: "pay_dummy", terms, cancellationRecoveryRequired: true }));
  await phase(t, ref, value);
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await row(t, ref)).toMatchObject({ cancellationLastOutcome: "support", cancellationRecoveryRequired: true });
  expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ state: "settled", cancellationRecoveryRequired: true });
  expect(await t.run(ctx => ctx.db.query("billingGrants").take(1))).toEqual([]);
});

test("settled charge before the deletion skew window can finish recovery", async () => {
  const t = setup(), ref = await customer(t); provider({ succeededAt: NOW - PROVIDER_CLOCK_SKEW_MS - 2 });
  const purchaseRef = await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "old_charge",
    state: "settled", paymentId: "pay_dummy", terms, cancellationRecoveryRequired: true }));
  await phase(t, ref, "purchases");
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await row(t, ref)).toMatchObject({ cancellationLastOutcome: "complete" });
  expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ state: "settled", cancellationRecoveryRequired: false });
});

test("verified late-bound customer can recover while its creation state stays unknown", async () => {
  const t = setup(), ref = await customer(t, { creationState: "unknown" }); provider();
  for (let i = 0; i < 4; i++) await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await row(t, ref)).toMatchObject({ creationState: "unknown", cancellationLastOutcome: "complete" });
});

test("sweep preserves lease-expiry wakeup for evidence arriving during a live claim", async () => {
  const t = setup(), ref = await customer(t); const c = await claim(t, ref);
  await t.run(ctx => queueDeletionRecovery(ctx, ref));
  await t.mutation(internal.billingCancellation.selectCancellationTargets, {});
  expect((await row(t, ref))!.cancellationNextAttemptAt).toBe(NOW + CANCELLATION_LEASE_MS);
  expect(await commit(t, ref, c)).toBe("stale");
  vi.setSystemTime(NOW + CANCELLATION_LEASE_MS + 1);
  await t.mutation(internal.billingCancellation.selectCancellationTargets, {});
  expect((await claim(t, ref)).inputRevision).toBeGreaterThan(c.inputRevision);
});

test.each(["999999999999999999999", "Fri, 01 Jan 2100 00:00:00 GMT"])("Retry-After %s is capped", async retryAfter => {
  const t = setup(), ref = await customer(t); provider({ failure: 429, retryAfter });
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect((await row(t, ref))!.cancellationNextAttemptAt).toBe(NOW + CANCELLATION_MAX_DELAY_MS);
});

test("temporary receipt blocker retries with backoff and exhausts to support", async () => {
  const t = setup(), ref = await customer(t, { unresolvedReceipts: 1 }); provider();
  for (let attempt = 1; attempt <= CANCELLATION_MAX_ATTEMPTS; attempt++) {
    for (let i = 0; i < 4; i++) await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
    expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationAttempts: attempt,
      cancellationLastOutcome: attempt === CANCELLATION_MAX_ATTEMPTS ? "support" : "retry" });
    expect((await row(t, ref))!.cancellationNextAttemptAt).toBeGreaterThan(NOW);
  }
});

test.each(["marker", "renewable", "control", "processing", "open", "unknown"])("final proof refuses leftover %s outside the current cursor", async blocker => {
  const t = setup(), ref = await customer(t); provider();
  if (blocker === "processing" || blocker === "open" || blocker === "unknown") await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "hidden",
    state: blocker, terms }));
  else await t.run(ctx => ctx.db.insert("billingSubscriptions", { customerRef: ref, mode, subscriptionId: "sub_hidden", productId: "pdt_pro",
    status: blocker === "renewable" ? "active" : "cancelled", cancellationRecoveryRequired: blocker === "marker",
    ...(blocker === "control" ? { controlPendingAt: NOW, controlOperation: "cancel" as const } : {}) }));
  await phase(t, ref, "purchases");
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await row(t, ref)).toMatchObject({ cancellationRecoveryRequired: true, cancellationLastOutcome: "retry" });
});

test("ended subscription status is persisted atomically with marker clearance, retaining paid periods", async () => {
  const t = setup(), ref = await customer(t); provider();
  const subRef = await t.run(ctx => ctx.db.insert("billingSubscriptions", { customerRef: ref, mode, subscriptionId: "sub_old", productId: "pdt_pro",
    status: "active", paidThrough: NOW + 10000, cancellationRecoveryRequired: true }));
  const key = "poll:subscription:sub_old:cancelled";
  await t.mutation(internal.billing.recordReceipt, { customerRef: ref, mode, webhookId: key, eventType: "subscription.poll", subscriptionId: "sub_old",
    bodyDigest: await sha256Hex(new TextEncoder().encode(key)), occurredAt: NOW, ignored: true });
  await phase(t, ref, "knownSubscriptions");
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await t.run(ctx => ctx.db.get("billingSubscriptions", subRef))).toMatchObject({ status: "cancelled", paidThrough: NOW + 10000, cancellationRecoveryRequired: false });
});


test("expired open checkout becomes terminal before its marker clears without touching receipt leases", async () => {
  const t = setup(), ref = await customer(t, { leaseId: "receipt_lease", leaseExpiresAt: NOW + 60000 }); provider();
  const purchaseRef = await t.run(ctx => ctx.db.insert("billingPurchases", { customerRef: ref, mode, intentId: "expired_open",
    state: "open", sessionId: "cks_dummy", cancellationRecoveryRequired: true, terms }));
  await phase(t, ref, "purchases");
  await t.action(internal.billingCancellation.recoverCustomer, { customerRef: ref });
  expect(await t.run(ctx => ctx.db.get("billingPurchases", purchaseRef))).toMatchObject({ state: "terminal", cancellationRecoveryRequired: false });
  expect(await row(t, ref)).toMatchObject({ cancellationLastOutcome: "complete", leaseId: "receipt_lease", leaseExpiresAt: NOW + 60000 });
  for (const table of ["purchases", "subscriptions"] as const)
    await t.mutation(internal.billingDeletion.markDeletionBatch, { customerRef: ref, table, cursor: null });
  expect(await row(t, ref)).toMatchObject({ cancellationLastOutcome: "complete", cancellationRecoveryRequired: false });
});
