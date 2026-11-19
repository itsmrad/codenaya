// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  ACTIVE_POLL_MS, CHECKOUT_SESSION_TTL_MS, IDLE_POLL_MS, markPollDue, POLL_BATCH, POLL_READS_PER_CUSTOMER, REVERSAL_WATCH_MS,
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
  session?: object; failing?: string; full?: string;
};
const listed = (extra: Record<string, unknown>) => ({ created_at: iso(NOW), customer: { customer_id: "cus_user_alice" }, ...extra });
const topUpPayment = (paymentId: string, extra: Record<string, unknown> = {}) => ({
  payment_id: paymentId, business_id: "bus_synthetic", status: "succeeded", customer: { customer_id: "cus_user_alice" },
  subscription_id: null, checkout_session_id: "cks_1", product_cart: [{ product_id: TOP_UP, quantity: 1 }],
  total_amount: 1000, tax: 90, currency: "USD", created_at: iso(NOW), charge_type: null, ...extra,
});

/** Answers Dodo list, session and payment reads from `provider`. */
function stubProvider(provider: Provider) {
  const fetchMock = vi.fn(async (url: string) => {
    const { pathname } = new URL(url);
    const [, kind, id] = pathname.split("/");
    if (kind === provider.failing) return new Response("{}", { status: 503 });
    let body: unknown;
    if (kind === "checkouts") body = provider.session ?? { id, created_at: iso(NOW), payment_id: null, payment_status: null };
    else if (id) body = topUpPayment(id);
    else {
      const items = provider[kind as "payments"] ?? [];
      body = { items: kind === provider.full ? Array.from({ length: 20 }, (_, i) => ({ ...(items[0] ?? listed({ payment_id: "pay_x" })), [`${kind.slice(0, -1)}_id`]: `${kind}_${i}` })) : items };
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
    // Its reversal stays unresolved (stage 8): later buckets add nothing.
    later(IDLE_POLL_MS);
    await poll(t);
    expect((await events(t)).filter(e => e.eventType === "refund.poll")).toHaveLength(1);
    // A new top-up payment is blocked while the refund is unresolved.
    stubProvider({ payments: [listed({ payment_id: "pay_2", status: "succeeded" })] });
    later(IDLE_POLL_MS);
    await poll(t);
    await processCustomer(t, alice);
    expect(await grants(t)).toHaveLength(1);

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

describe("checkout lock release", () => {
  const expired = () => later(CHECKOUT_SESSION_TTL_MS + 1);

  test("an expired session with no payment releases the lock; a late payment still settles once", async () => {
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    stubProvider({});
    expired();
    await poll(t);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "terminal" });
    expect((await read(t, alice))!.pendingPurchaseRef).toBeUndefined();
    expect((await read(t, alice))!.nextPollAt).toBeUndefined();

    // The released purchase keeps its session, so the existing session match settles a late payment against it.
    await t.mutation(internal.billing.recordReceipt, {
      customerRef: alice, mode: "test_mode", webhookId: "wh_late", eventType: "payment.succeeded", bodyDigest: "a".repeat(64),
      occurredAt: 1, paymentId: "pay_late", sessionId: "cks_1",
    });
    await processCustomer(t, alice);
    expect(await read(t, purchaseRef)).toMatchObject({ state: "settled", paymentId: "pay_late" });
    expect(await grants(t)).toHaveLength(1);
    // A replayed or polled copy never grants twice.
    await t.mutation(internal.billing.recordReceipt, {
      customerRef: alice, mode: "test_mode", webhookId: "wh_late_again", eventType: "payment.succeeded", bodyDigest: "a".repeat(64),
      occurredAt: 1, paymentId: "pay_late", sessionId: "cks_1",
    });
    await processCustomer(t, alice);
    expect(await grants(t)).toHaveLength(1);
    expect((await t.run(ctx => ctx.db.query("billingPurchases").take(10)))).toHaveLength(1);
  });

  test.each([
    ["the session is not past its lifetime", {}, false],
    ["the session payment is processing", { session: { id: "cks_1", created_at: iso(NOW), payment_id: "pay_1", payment_status: "processing" } }, true],
    ["a read failed", { failing: "refunds" }, true],
    ["the session read failed", { failing: "checkouts" }, true],
    ["a list page is full", { full: "disputes" }, true],
    ["an unbound succeeded payment was listed", { payments: [listed({ payment_id: "pay_9", status: "succeeded" })] }, true],
  ] as const)("keeps the lock when %s", async (_name, provider, pastLifetime) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    const alice = await customer(t);
    const purchaseRef = await openCheckout(t, alice);
    stubProvider(provider);
    if (pastLifetime) expired();
    else later(ACTIVE_POLL_MS);
    await poll(t);
    expect((await read(t, alice))!.pendingPurchaseRef).toBe(purchaseRef);
    expect((await read(t, purchaseRef))!.state).toBe("open");
    // Still held: polled again at the active cadence.
    expect((await read(t, alice))!.nextPollAt).toBe(Date.now() + ACTIVE_POLL_MS);
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
    ["pending", true], ["on_hold", true], ["cancelled", false],
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
      customerRef: alice, mode: "test_mode", polledAt: Date.now(), complete: true, findings: [],
      checkout: { purchaseRef, sessionId: "cks_1" }, session: { createdAt: NOW },
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
