// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  ACTIVE_POLL_MS, CHECKOUT_SESSION_TTL_MS, IDLE_POLL_MS, markPollDue, POLL_BATCH, POLL_READS_PER_CUSTOMER, PROVIDER_CLOCK_SKEW_MS,
  MAX_POLL_PAGES, REVERSAL_WATCH_MS,
} from "./billingPoll";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 10, 12);
const PRO = "pdt_pro";
const TOP_UP = "pdt_topup";
const ENV = {
  CODENAYA_DEPLOYMENT: "development", DODO_PAYMENTS_ENVIRONMENT: "test_mode", DODO_PAYMENTS_BUSINESS_ID: "bus_synthetic",
  DODO_PAYMENTS_API_KEY: "sk_synthetic", DODO_PAYMENTS_PRO_PRODUCT_ID: PRO, DODO_PAYMENTS_TOP_UP_PRODUCT_ID: TOP_UP,
};
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function customer(t: T, userId = "user_alice") {
  await t.run(ctx => ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 }));
  const customerRef = await t.mutation(internal.billing.ensureCustomer, { mode: "test_mode", userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}` });
  await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: `cus_${userId}` });
  return customerRef;
}

/** An open checkout holding the lock, due for a poll, as recordCheckoutResult leaves it. */
async function openCheckout(t: T, customerRef: Id<"billingCustomers">, sku: "pro_monthly" | "top_up" = "top_up") {
  const pro = sku === "pro_monthly";
  const purchaseRef = await t.mutation(internal.billing.reservePurchase, {
    customerRef, intentId: "intent_1", terms: { sku, catalogVersion: "2026-11-17", productId: pro ? PRO : TOP_UP, quantity: 1, credits: pro ? 2000 : 1000 },
  });
  await t.mutation(internal.billing.bindPurchase, { purchaseRef, mode: "test_mode", sessionId: "cks_1" });
  await t.run(async ctx => {
    await ctx.db.patch("billingPurchases", purchaseRef, { state: "open" });
    await markPollDue(ctx, customerRef, false);
  });
  return purchaseRef;
}

type Provider = {
  payments?: readonly object[]; refunds?: readonly object[]; disputes?: readonly object[]; subscriptions?: readonly object[];
  session?: object; failing?: string;
  // Page 0 of this list is full (20 synthetic items); page 1 holds the list's own items.
  full?: string;
  // Re-reads by id: a subscription's status, extra fields on a payment.
  subscriptionReads?: Record<string, string>; paymentReads?: Record<string, Record<string, unknown>>;
};
const listed = (extra: Record<string, unknown>) => ({ created_at: iso(NOW), customer: { customer_id: "cus_user_alice" }, ...extra });
const topUpPayment = (paymentId: string, extra: Record<string, unknown> = {}) => ({
  payment_id: paymentId, business_id: "bus_synthetic", status: "succeeded", customer: { customer_id: "cus_user_alice" },
  subscription_id: null, checkout_session_id: "cks_1", product_cart: [{ product_id: TOP_UP, quantity: 1 }],
  total_amount: 1000, tax: 90, currency: "USD", created_at: iso(NOW), charge_type: null, refunds: [], disputes: [], ...extra,
});
const subscriptionRead = (subscriptionId: string, status: string) => ({
  subscription_id: subscriptionId, status, product_id: PRO, customer: { customer_id: "cus_user_alice" }, quantity: 1,
  previous_billing_date: iso(NOW - 20 * DAY), next_billing_date: iso(NOW + 10 * DAY), cancel_at_next_billing_date: false,
});

/** Answers Dodo list, session and by-id reads from `provider`. */
function stubProvider(provider: Provider) {
  const fetchMock = vi.fn(async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    const [, kind, id] = pathname.split("/");
    if (kind === provider.failing) return new Response("{}", { status: 503 });
    let body: unknown;
    if (kind === "checkouts") body = provider.session ?? { id, created_at: iso(NOW), payment_id: null, payment_status: null };
    else if (kind === "subscriptions" && id) body = subscriptionRead(id, provider.subscriptionReads?.[id] ?? "active");
    else if (id) body = topUpPayment(id, provider.paymentReads?.[id]);
    else {
      const items = provider[kind as "payments"] ?? [];
      const filler = Array.from({ length: 20 }, (_, i) => ({ ...listed({ status: "failed" }), [`${kind.slice(0, -1)}_id`]: `${kind}_${i}`, payment_id: `pay_f${i}` }));
      const page = Number(searchParams.get("page_number"));
      body = { items: kind === provider.full ? (page === 0 ? filler : page === 1 ? items : []) : page === 0 ? items : [] };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const pendingRuns = (t: T, name: string) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").take(500)).filter(run => run.state.kind === "pending" && run.name.endsWith(name)));

/** One cron bucket: select due customers, then run each scheduled poll once. */
async function poll(t: T) {
  await t.mutation(internal.billingPoll.selectPollTargets, {});
  const runs = await pendingRuns(t, "pollCustomer");
  for (const run of runs) {
    await t.run(ctx => ctx.scheduler.cancel(run._id));
    await t.action(internal.billingPoll.pollCustomer, run.args[0] as never);
  }
  return runs.length;
}
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const processCustomer = (t: T, customerRef: Id<"billingCustomers">) => t.action(internal.billingQueue.processCustomer, { customerRef });
const events = (t: T) => t.run(ctx => ctx.db.query("billingEvents").take(100));
const grants = (t: T) => t.run(ctx => ctx.db.query("billingGrants").take(100));
const read = <Table extends "billingCustomers" | "billingPurchases">(t: T, ref: Id<Table>) => t.run(ctx => ctx.db.get(ref));

describe("missed webhooks", () => {
  test("an unbound succeeded payment becomes one synthetic receipt that grants once", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    stubProvider({ payments: [listed({ payment_id: "pay_1", status: "succeeded" })], session: { id: "cks_1", created_at: iso(NOW), payment_id: "pay_1", payment_status: "succeeded" } });
    later(ACTIVE_POLL_MS);
    expect(await poll(t)).toBe(1);
    expect(await events(t)).toMatchObject([{ webhookId: "poll:payment:pay_1:succeeded", eventType: "payment.poll", paymentId: "pay_1", state: "pending" }]);
    // While its receipt is unresolved the same payment is never recorded again.
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect(await events(t)).toHaveLength(1);
    await processCustomer(t, alice);
    expect(await grants(t)).toHaveLength(1);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", paymentId: "pay_1" });
    // Settled: bound, so later polls record nothing and grant nothing.
    later(IDLE_POLL_MS);
    await poll(t);
    expect(await events(t)).toHaveLength(1);
    expect(await grants(t)).toHaveLength(1);
  });

  test("a succeeded payment that grants nothing is recorded once, and a failed one never", async () => {
    const t = setup();
    const alice = await customer(t);
    await t.run(ctx => markPollDue(ctx, alice, true));
    stubProvider({ payments: [listed({ payment_id: "pay_card", status: "succeeded" }), listed({ payment_id: "pay_failed", status: "failed" })] });
    for (let i = 0; i < 3; i++) {
      later(IDLE_POLL_MS);
      await poll(t);
      await t.run(async ctx => {
        for (const row of await ctx.db.query("billingEvents").take(10)) await ctx.db.patch("billingEvents", row._id, { state: "processed" });
      });
    }
    expect((await events(t)).map(e => e.webhookId)).toEqual(["poll:payment:pay_card:succeeded"]);
  });

  test("a missed refund is recorded once, blocks positives, and a top-up-only customer stays watched", async () => {
    const t = setup();
    const alice = await customer(t);
    await openCheckout(t, alice);
    stubProvider({ payments: [listed({ payment_id: "pay_1", status: "succeeded" })] });
    later(ACTIVE_POLL_MS);
    await poll(t);
    await processCustomer(t, alice);
    const settled = (await read(t, alice))!;
    expect(settled.pendingPurchaseRef).toBeUndefined();
    expect(settled.watchUntil).toBe(Date.now() + REVERSAL_WATCH_MS);
    expect(settled.nextPollAt).toBeLessThanOrEqual(Date.now() + ACTIVE_POLL_MS);

    stubProvider({
      payments: [listed({ payment_id: "pay_1", status: "succeeded" })],
      refunds: [listed({ refund_id: "ref_1", payment_id: "pay_1", status: "succeeded" }), listed({ refund_id: "ref_2", payment_id: "pay_1", status: "pending" })],
    });
    later(30 * DAY);
    await poll(t);
    const refund = (await events(t)).filter(e => e.eventType === "refund.poll");
    expect(refund).toMatchObject([{ webhookId: "poll:refund:ref_1:succeeded", paymentId: "pay_1", state: "pending" }]);
    expect((await read(t, alice))!.nextPollAt).toBe(Date.now() + IDLE_POLL_MS);
    // The webhook copy of the same refund arrives too. Reversal handling resolves both from one payment
    // read into one adjustment row (unique per provider id): the refund is applied exactly once.
    await t.mutation(internal.billing.recordReceipt, {
      customerRef: alice, mode: "test_mode", webhookId: "wh_refund", eventType: "refund.succeeded", bodyDigest: "a".repeat(64), occurredAt: 1, paymentId: "pay_1",
    });
    const refunded = { refunds: [{ refund_id: "ref_1", payment_id: "pay_1", business_id: "bus_synthetic", status: "succeeded", amount: 1000, currency: "USD", is_partial: false, created_at: iso(NOW) }] };
    stubProvider({ paymentReads: { pay_1: refunded } });
    await processCustomer(t, alice);
    const adjustments = () => t.run(ctx => ctx.db.query("billingAdjustments").take(10));
    expect((await adjustments()).map(a => [a.kind, a.providerId, a.status])).toEqual([["refund", "ref_1", "succeeded"]]);
    expect((await events(t)).filter(e => e.paymentId === "pay_1" && /^refund\./.test(e.eventType)).map(e => e.state)).toEqual(["processed", "processed"]);
    const revoked = (await t.run(ctx => ctx.db.query("billingPurchases").take(10))).find(p => p.paymentId === "pay_1")!.revokedCredits;
    expect(revoked).toBe(1000);
    // Later buckets record nothing new for the same status, and a further read applies nothing twice.
    stubProvider({ refunds: [listed({ refund_id: "ref_1", payment_id: "pay_1", status: "succeeded" })], paymentReads: { pay_1: refunded } });
    later(IDLE_POLL_MS);
    await poll(t);
    await processCustomer(t, alice);
    expect((await events(t)).filter(e => e.eventType === "refund.poll")).toHaveLength(1);
    expect(await adjustments()).toHaveLength(1);
    expect((await t.run(ctx => ctx.db.query("billingPurchases").take(10))).find(p => p.paymentId === "pay_1")!.revokedCredits).toBe(1000);

    // After the watch, with no lock or subscription, the customer is no longer polled.
    stubProvider({});
    later(REVERSAL_WATCH_MS);
    await poll(t);
    expect((await read(t, alice))!.nextPollAt).toBeUndefined();
    expect(await poll(t)).toBe(0);
  });

  test("subscriptions: a missing local row or a provider-ended one is recorded; an unchanged one is not", async () => {
    const t = setup();
    const alice = await customer(t);
    await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode: "test_mode", subscriptionId: "sub_live", productId: PRO });
    await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode: "test_mode", subscriptionId: "sub_ended", productId: PRO });
    await t.run(ctx => markPollDue(ctx, alice, true));
    stubProvider({
      subscriptions: [
        listed({ subscription_id: "sub_live", status: "active" }), listed({ subscription_id: "sub_ended", status: "cancelled" }),
        listed({ subscription_id: "sub_new", status: "active" }),
      ],
    });
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect((await events(t)).map(e => [e.webhookId, e.eventType, e.subscriptionId])).toEqual([
      ["poll:subscription:sub_ended:cancelled", "subscription.poll", "sub_ended"],
      ["poll:subscription:sub_new:active", "subscription.poll", "sub_new"],
    ]);
  });
});

describe("re-reads and reversal recording", () => {
  test("an older known subscription is re-read by id, so its missed cancellation is recorded", async () => {
    const t = setup();
    const alice = await customer(t);
    const subRef = await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode: "test_mode", subscriptionId: "sub_old", productId: PRO });
    await t.run(async ctx => {
      await ctx.db.patch("billingSubscriptions", subRef, { status: "active", paidThrough: NOW + 20 * DAY });
      await markPollDue(ctx, alice, true);
    });
    // Created long ago: not in any list window.
    const fetchMock = stubProvider({ subscriptionReads: { sub_old: "cancelled" } });
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain("/subscriptions/sub_old");
    expect((await events(t)).map(e => [e.webhookId, e.subscriptionId])).toEqual([["poll:subscription:sub_old:cancelled", "sub_old"]]);
  });

  test("a payment with an unresolved dispute is re-read, so a later dispute status is still recorded", async () => {
    const t = setup();
    const alice = await customer(t);
    await t.mutation(internal.billing.recordReceipt, {
      customerRef: alice, mode: "test_mode", webhookId: "wh_dispute", eventType: "dispute.opened", bodyDigest: "a".repeat(64), occurredAt: 1, paymentId: "pay_d",
    });
    await t.run(ctx => markPollDue(ctx, alice, true));
    const dispute = { dispute_id: "dsp_1", payment_id: "pay_d", business_id: "bus_synthetic", amount: "1000", currency: "USD", created_at: iso(NOW) };
    stubProvider({ paymentReads: { pay_d: { refunds: [], disputes: [{ ...dispute, dispute_status: "dispute_lost" }] } } });
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect((await events(t)).map(e => [e.webhookId, e.eventType, e.state])).toEqual([
      ["wh_dispute", "dispute.opened", "pending"], ["poll:dispute:dsp_1:lost", "dispute.poll", "pending"],
    ]);
    // The same status again is a no-op.
    later(IDLE_POLL_MS);
    await poll(t);
    expect(await events(t)).toHaveLength(2);
  });

  test("an unresolved positive receipt of the payment never suppresses its refund", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    const eventRef = await t.mutation(internal.billing.recordReceipt, {
      customerRef: alice, mode: "test_mode", webhookId: "wh_pay", eventType: "payment.succeeded", bodyDigest: "a".repeat(64), occurredAt: 1, paymentId: "pay_1",
    });
    await t.run(async ctx => {
      await ctx.db.patch("billingEvents", eventRef, { state: "quarantined", quarantineReason: "digest_mismatch" });
      await markPollDue(ctx, alice, true);
    });
    stubProvider({
      payments: [listed({ payment_id: "pay_1", status: "succeeded" })],
      refunds: [listed({ refund_id: "ref_1", payment_id: "pay_1", status: "succeeded" })],
    });
    later(ACTIVE_POLL_MS);
    await poll(t);
    // The payment itself waits behind its quarantined receipt; its refund is recorded.
    expect((await events(t)).map(e => e.webhookId).sort()).toEqual(["poll:refund:ref_1:succeeded", "wh_pay"]);
  });
});

describe("checkout lock release", () => {
  const expired = () => later(CHECKOUT_SESSION_TTL_MS + PROVIDER_CLOCK_SKEW_MS + 1);
  const lateReceipt = (t: T, customerRef: Id<"billingCustomers">, webhookId: string, paymentId: string) => t.mutation(internal.billing.recordReceipt, {
    customerRef, mode: "test_mode", webhookId, eventType: "payment.succeeded", bodyDigest: "a".repeat(64), occurredAt: 1, paymentId, sessionId: "cks_1",
  });

  test("an expired session with no payment releases the lock; a late payment still settles once", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    // An earlier top-up's settled payment, from before the purchase, cannot be this checkout's: it never blocks.
    await t.run(ctx => ctx.db.insert("billingPurchases", {
      customerRef: alice, mode: "test_mode", intentId: "intent_old", paymentId: "pay_old", state: "settled",
      terms: { sku: "top_up", catalogVersion: "2026-11-17", productId: TOP_UP, quantity: 1, credits: 1000 },
    }));
    stubProvider({ payments: [listed({ payment_id: "pay_old", status: "succeeded", created_at: iso(NOW - DAY) })] });
    expired();
    await poll(t);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "terminal" });
    expect((await read(t, alice))!.pendingPurchaseRef).toBeUndefined();

    // The released purchase keeps its session, so the existing session match settles a late payment against it.
    stubProvider({});
    await lateReceipt(t, alice, "wh_late", "pay_late");
    await processCustomer(t, alice);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", paymentId: "pay_late" });
    expect(await grants(t)).toHaveLength(1);
    // A replayed or polled copy never grants twice.
    await lateReceipt(t, alice, "wh_late_again", "pay_late");
    await processCustomer(t, alice);
    expect(await grants(t)).toHaveLength(1);
  });

  test("Pro: a late period payment after release settles the released purchase once", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice, "pro_monthly");
    stubProvider({});
    expired();
    await poll(t);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "terminal" });
    const start = Date.now();
    stubProvider({
      subscriptionReads: { sub_1: "active" },
      paymentReads: {
        pay_pro: {
          subscription_id: "sub_1", product_cart: null, total_amount: 2000, tax: 180, charge_type: "new",
          service_periods: [{ subscription_id: "sub_1", starts_at: iso(start), ends_at: iso(start + 30 * DAY), proration_factor: "1" }],
        },
      },
    });
    await lateReceipt(t, alice, "wh_pro", "pay_pro");
    await processCustomer(t, alice);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", paymentId: "pay_pro", subscriptionId: "sub_1" });
    await lateReceipt(t, alice, "wh_pro_again", "pay_pro");
    await processCustomer(t, alice);
    expect((await grants(t)).map(g => g.kind)).toEqual(["current_period"]);
  });

  test.each([
    ["the session is not past its lifetime", {}, () => later(ACTIVE_POLL_MS)],
    ["the lifetime has passed only within the clock-skew margin", {}, () => later(CHECKOUT_SESSION_TTL_MS + 1)],
    ["the session payment is processing", { session: { id: "cks_1", created_at: iso(NOW), payment_id: "pay_1", payment_status: "processing" } }, expired],
    ["a read failed", { failing: "refunds" }, expired],
    ["the session read failed", { failing: "checkouts" }, expired],
    ["a list page is full", { full: "disputes" }, expired],
    ["a succeeded payment was listed", { payments: [listed({ payment_id: "pay_9", status: "succeeded" })] }, expired],
    ["a processing payment was listed", { payments: [listed({ payment_id: "pay_9", status: "processing" })] }, expired],
  ] as const)("keeps the lock when %s", async (_name, provider, advance) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    stubProvider(provider);
    advance();
    await poll(t);
    expect((await read(t, alice))!.pendingPurchaseRef).toBe(purchaseRef);
    expect((await read(t, purchaseRef))!.state).toBe("open");
    // Still held: polled again at the active cadence.
    expect((await read(t, alice))!.nextPollAt).toBe(Date.now() + ACTIVE_POLL_MS);
  });

  test("a bound processing payment since the purchase keeps the lock too", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    const other = await t.run(ctx => ctx.db.insert("billingPurchases", {
      customerRef: alice, mode: "test_mode", intentId: "renewal:pay_b", paymentId: "pay_b", state: "processing",
      terms: { sku: "top_up", catalogVersion: "2026-11-17", productId: TOP_UP, quantity: 1, credits: 1000 },
    }));
    stubProvider({ payments: [listed({ payment_id: "pay_b", status: "processing" })] });
    expired();
    await poll(t);
    expect((await read(t, alice))!.pendingPurchaseRef).toBe(purchaseRef);
    expect(other).toBeDefined();
  });

  test("a Pro renewal bound to its own purchase does not block an abandoned top-up; an unbound one does", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    // The subscriber's renewal landed within the checkout's lifetime and settled against its own purchase.
    await t.run(ctx => ctx.db.insert("billingPurchases", {
      customerRef: alice, mode: "test_mode", intentId: "renewal:pay_r", paymentId: "pay_r", subscriptionId: "sub_1", state: "settled",
      terms: { sku: "pro_monthly", catalogVersion: "2026-11-17", productId: PRO, quantity: 1, credits: 2000 },
    }));
    stubProvider({ payments: [listed({ payment_id: "pay_r", status: "succeeded", created_at: iso(NOW + 60 * 60_000) })] });
    expired();
    await poll(t);
    expect((await read(t, alice))!.pendingPurchaseRef).toBeUndefined();
    expect(await read(t, purchaseRef)).toMatchObject({ state: "terminal" });

    const t2 = setup();
    const bob = await customer(t2, "user_bob");
    const bobPurchase = await openCheckout(t2, bob);
    stubProvider({ payments: [listed({ payment_id: "pay_u", status: "succeeded", customer: { customer_id: "cus_user_bob" } })] });
    expired();
    await poll(t2);
    expect((await read(t2, bob))!.pendingPurchaseRef).toBe(bobPurchase);
  });

  test("a window past the page cap closes without releasing the lock and alerts", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    expired();
    const until = Date.now();
    await t.mutation(internal.billingPoll.recordPollFindings, {
      customerRef: alice, mode: "test_mode", window: { since: 0, until, pages: { payments: MAX_POLL_PAGES - 1 }, blocked: false }, pages: {},
      failed: false, capped: true, findings: [], checkout: { purchaseRef, sessionId: "cks_1" }, session: { createdAt: NOW },
    });
    const after = (await read(t, alice))!;
    expect(after.pendingPurchaseRef).toBe(purchaseRef);
    expect(after).toMatchObject({ lastPolledAt: until });
    expect(after.pollWindow).toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[billingPoll] page cap reached; lock kept", { customerRef: alice, pages: MAX_POLL_PAGES });
  });

  test("a full page is paged through on the next run, then the window closes and the lock is released", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    const fetchMock = stubProvider({ full: "payments" });
    expired();
    await poll(t);
    const paging = (await read(t, alice))!;
    expect(paging.pendingPurchaseRef).toBe(purchaseRef);
    expect(paging.pollWindow).toMatchObject({ pages: { payments: 1 }, blocked: false });
    expect(paging.lastPolledAt).toBeUndefined();
    const until = paging.pollWindow!.until;
    later(ACTIVE_POLL_MS);
    fetchMock.mockClear();
    await poll(t);
    // Only the unfinished list is read, at its next page, in the same window.
    const lists = fetchMock.mock.calls.map(([url]) => new URL(String(url))).filter(url => url.pathname === "/payments");
    expect(lists.map(url => [url.searchParams.get("page_number"), url.searchParams.get("created_at_lte")])).toEqual([["1", iso(until)]]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/refunds?"))).toBe(false);
    const done = (await read(t, alice))!;
    expect(done).toMatchObject({ lastPolledAt: until });
    expect(done.pollWindow).toBeUndefined();
    expect(done.pendingPurchaseRef).toBeUndefined();
  });

  test("a blocker seen on an earlier page of the window still keeps the lock when the window closes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    stubProvider({ full: "disputes", payments: [listed({ payment_id: "pay_9", status: "processing" })] });
    expired();
    await poll(t);
    expect((await read(t, alice))!.pollWindow).toMatchObject({ blocked: true });
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect((await read(t, alice))!.pollWindow).toBeUndefined();
    expect((await read(t, alice))!.pendingPurchaseRef).toBe(purchaseRef);
    // The next window sees the payment failed: released.
    stubProvider({ payments: [listed({ payment_id: "pay_9", status: "failed" })] });
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect((await read(t, alice))!.pendingPurchaseRef).toBeUndefined();
  });

  test("a session whose only payment failed is released", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    stubProvider({ session: { id: "cks_1", created_at: iso(NOW), payment_id: "pay_1", payment_status: "failed" } });
    expired();
    await poll(t);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "terminal" });
    expect((await read(t, alice))!.pendingPurchaseRef).toBeUndefined();
  });

  test.each([
    ["pending", true], ["on_hold", true], ["past_due", true], ["Not A Status", true], ["cancelled", false],
  ] as const)("Pro: a %s subscription created since the purchase keeps the lock: %s", async (status, kept) => {
    const t = setup();
    const alice = await customer(t);
    const pro = await openCheckout(t, alice, "pro_monthly");
    stubProvider({ subscriptions: [listed({ subscription_id: "sub_1", status })] });
    expired();
    await poll(t);
    expect((await read(t, alice))!.pendingPurchaseRef).toBe(kept ? pro : undefined);
  });

  test("re-checks state: a purchase that settled after the action's read is not released", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    expired();
    await t.run(async ctx => {
      await ctx.db.patch("billingPurchases", purchaseRef, { state: "settled", paymentId: "pay_1" });
    });
    await t.mutation(internal.billingPoll.recordPollFindings, {
      customerRef: alice, mode: "test_mode", window: { since: 0, until: Date.now(), pages: {}, blocked: false }, pages: {},
      failed: false, capped: false, findings: [], checkout: { purchaseRef, sessionId: "cks_1" }, session: { createdAt: NOW },
    });
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled" });
    expect((await read(t, alice))!.pendingPurchaseRef).toBe(purchaseRef);
  });
});

describe("budget and cadence", () => {
  test("a poll makes at most POLL_READS_PER_CUSTOMER reads; a run selects at most POLL_BATCH customers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    const refs: Id<"billingCustomers">[] = [];
    for (let i = 0; i < POLL_BATCH + 2; i++) refs.push(await customer(t, `user_${i}`));
    await openCheckout(t, refs[0]!);
    for (const ref of refs.slice(1)) await t.run(ctx => markPollDue(ctx, ref, true));
    const fetchMock = stubProvider({});
    later(ACTIVE_POLL_MS);
    expect(await poll(t)).toBe(POLL_BATCH);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(POLL_BATCH * POLL_READS_PER_CUSTOMER);
    const first = fetchMock.mock.calls.filter(([url]) => String(url).includes("cus_user_0") || String(url).includes("/checkouts/"));
    expect(first.length).toBeLessThanOrEqual(POLL_READS_PER_CUSTOMER);
    expect(await poll(t)).toBe(2);
  });

  test("an active subscription polls idly, and actively within 48 h of paidThrough; a poll never extends paidThrough", async () => {
    const t = setup();
    const alice = await customer(t);
    const subRef = await t.mutation(internal.billing.bindSubscription, { customerRef: alice, mode: "test_mode", subscriptionId: "sub_1", productId: PRO });
    await t.run(async ctx => {
      await ctx.db.patch("billingSubscriptions", subRef, { status: "active", paidThrough: NOW + 10 * DAY });
      await ctx.db.patch("billingCustomers", alice, { activeSubscriptionRef: subRef });
      await markPollDue(ctx, alice, false);
    });
    stubProvider({ subscriptions: [listed({ subscription_id: "sub_1", status: "active" })] });
    later(ACTIVE_POLL_MS);
    await poll(t);
    expect((await read(t, alice))!.nextPollAt).toBe(Date.now() + IDLE_POLL_MS);
    vi.setSystemTime(NOW + 9 * DAY);
    await poll(t);
    expect((await read(t, alice))!.nextPollAt).toBe(Date.now() + ACTIVE_POLL_MS);
    expect(await t.run(ctx => ctx.db.get(subRef))).toMatchObject({ paidThrough: NOW + 10 * DAY });
    expect(await events(t)).toEqual([]);
  });

  test("without billing config the cron selects nothing", async () => {
    const t = setup();
    const alice = await customer(t);
    await t.run(ctx => markPollDue(ctx, alice, true));
    vi.stubEnv("CODENAYA_DEPLOYMENT", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    later(ACTIVE_POLL_MS);
    expect(await poll(t)).toBe(0);
  });
});
