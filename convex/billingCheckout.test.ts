// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isDodoCheckoutUrl } from "../src/features/billing/checkout-url";
import { BILLING_CATALOG_VERSION } from "../src/features/billing/settlement";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CHECKOUT_PREPARE_STALE_MS, CUSTOMER_LEASE_STALE_MS } from "./billingCheckout";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const setup = () => convexTest(schema, modules);
type TestBackend = ReturnType<typeof setup>;
type Caller = ReturnType<TestBackend["withIdentity"]>;

const KEY = "synthetic-internal-key";
const PRO = "prod_pro_synthetic";
const TOP_UP = "prod_top_up_synthetic";
const NOW = Date.UTC(2026, 10, 19, 12);
const DAY = 24 * 60 * 60_000;
const mode = "test_mode" as const;
const URL_OK = "https://test.checkout.dodopayments.com/session/cks_synthetic";
const ENV: Record<string, string | undefined> = {
  CODENAYA_CONVEX_INTERNAL_KEY: KEY, CODENAYA_DEPLOYMENT: "development", DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PAYMENTS_BUSINESS_ID: "bus_synthetic", DODO_PAYMENTS_API_KEY: "sk_synthetic",
  DODO_PAYMENTS_PRO_PRODUCT_ID: PRO, DODO_PAYMENTS_TOP_UP_PRODUCT_ID: TOP_UP,
};

const logs: unknown[][] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  logs.length = 0;
  for (const level of ["error", "warn", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function user(t: TestBackend, userId: string) {
  await t.run(async ctx => {
    if (!await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique()) {
      await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
    }
  });
  return t.withIdentity({ subject: userId, issuer: "https://clerk.synthetic" });
}

const prepare = (as: Caller | TestBackend, sku: "pro_monthly" | "top_up" = "pro_monthly", over: Record<string, string> = {}) =>
  as.mutation(api.billingCheckout.prepareCheckout, { internalKey: KEY, mode, sku, productId: sku === "pro_monthly" ? PRO : TOP_UP, ...over });
type CustomerResult = { kind: "created"; customerId: string } | { kind: "not_created" } | { kind: "unknown" };
const recordCustomer = (as: Caller, customerRef: Id<"billingCustomers">, leaseId: string, result: CustomerResult) =>
  as.mutation(api.billingCheckout.recordCustomerResult, { internalKey: KEY, customerRef, leaseId, result });
type CheckoutResult = { kind: "created"; sessionId: string; checkoutUrl?: string; expiresAt?: number } | { kind: "not_created" } | { kind: "unknown" };
const recordCheckout = (as: Caller, purchaseRef: Id<"billingPurchases">, result: CheckoutResult) =>
  as.mutation(api.billingCheckout.recordCheckoutResult, { internalKey: KEY, purchaseRef, result });

/** toMatchObject, where an `undefined` expectation means the field is absent. */
function expectRow(row: object | null, expected: Record<string, unknown>) {
  expect(row).not.toBeNull();
  const fields = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) expect(fields[key], key).toBeUndefined();
    else if (typeof value === "object" && value !== null) expect(fields[key], key).toMatchObject(value);
    else expect(fields[key], key).toBe(value);
  }
}

const customerOf = (t: TestBackend, userId: string) => t.run(ctx => ctx.db.query("billingCustomers")
  .withIndex("by_mode_and_userId", q => q.eq("mode", mode).eq("userId", userId)).unique());
const purchaseOf = (t: TestBackend, ref: Id<"billingPurchases">) => t.run(ctx => ctx.db.get("billingPurchases", ref));

/** Leases and binds the caller's provider customer; returns its ref. */
async function readyCustomer(t: TestBackend, as: Caller, userId: string, sku: "pro_monthly" | "top_up" = "pro_monthly") {
  const step = await prepare(as, sku);
  if (step.kind !== "create_customer") throw new Error(`expected create_customer, got ${step.kind}`);
  await recordCustomer(as, step.customerRef, step.leaseId, { kind: "created", customerId: `cus_${userId}` });
  return step.customerRef;
}

/** Runs the flow up to a reserved purchase. */
async function reserved(t: TestBackend, as: Caller, userId: string, sku: "pro_monthly" | "top_up" = "pro_monthly") {
  if (!(await customerOf(t, userId))?.customerId) await readyCustomer(t, as, userId, sku);
  const step = await prepare(as, sku);
  if (step.kind !== "create_checkout") throw new Error(`expected create_checkout, got ${JSON.stringify(step)}`);
  return step;
}

/** A started period lot, so the owner is in a paid period. */
const paidPeriod = (t: TestBackend, customerRef: Id<"billingCustomers">, userId: string) => t.run(ctx => ctx.db.insert("billingGrants", {
  mode, sourceKey: `period:${userId}`, customerRef, userId, kind: "current_period", quantity: 2000, consumed: 0, revoked: 0,
  expiresAt: NOW + 20 * DAY, serviceStart: NOW - DAY, serviceEnd: NOW + 20 * DAY,
}));
const topUpLots = (t: TestBackend, customerRef: Id<"billingCustomers">, userId: string, count: number, exhausted: boolean) =>
  t.run(async ctx => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("billingGrants", {
        mode, sourceKey: `top_up:${exhausted}:${i}`, customerRef, userId, kind: "top_up", quantity: 1000,
        consumed: exhausted ? 1000 : 0, revoked: 0, expiresAt: NOW + 300 * DAY, ...(exhausted ? { exhausted: true as const } : {}),
      });
    }
  });

describe("checkout bridge authorization", () => {
  test("requires the internal key and a signed-in caller", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    await expect(prepare(alice, "pro_monthly", { internalKey: "wrong" })).rejects.toThrow("UNAUTHENTICATED");
    await expect(prepare(alice, "pro_monthly", { internalKey: "" })).rejects.toThrow("UNAUTHENTICATED");
    await expect(prepare(t)).rejects.toThrow("UNAUTHENTICATED");
    const customerRef = await readyCustomer(t, alice, "user_alice");
    await expect(t.mutation(api.billingCheckout.recordCustomerResult, {
      internalKey: KEY, customerRef, leaseId: "x", result: { kind: "unknown" },
    })).rejects.toThrow("UNAUTHENTICATED");
    await expect(alice.mutation(api.billingCheckout.recordCustomerResult, {
      internalKey: "wrong", customerRef, leaseId: "x", result: { kind: "unknown" },
    })).rejects.toThrow("UNAUTHENTICATED");
  });

  test("another owner cannot record Alice's results or resume her session", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const bob = await user(t, "user_bob");
    const lease = await prepare(alice);
    if (lease.kind !== "create_customer") throw new Error("expected lease");
    await expect(recordCustomer(bob, lease.customerRef, lease.leaseId, { kind: "created", customerId: "cus_bob" })).rejects.toThrow("NOT_FOUND");
    await recordCustomer(alice, lease.customerRef, lease.leaseId, { kind: "created", customerId: "cus_user_alice" });
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    await expect(recordCheckout(bob, purchaseRef, { kind: "created", sessionId: "cks_bob", checkoutUrl: URL_OK })).rejects.toThrow("NOT_FOUND");
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_alice", checkoutUrl: URL_OK });
    expect(await prepare(alice)).toEqual({ kind: "resume", checkoutUrl: URL_OK });
    // Bob gets his own lease and later only his own provider customer, never Alice's.
    await readyCustomer(t, bob, "user_bob");
    expect(await reserved(t, bob, "user_bob")).toMatchObject({ kind: "create_checkout", customerId: "cus_user_bob" });
  });

  test("deleted or held owners get FORBIDDEN, even with an open session", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_alice", checkoutUrl: URL_OK });
    const customer = (await customerOf(t, "user_alice"))!;
    await t.run(ctx => ctx.db.patch("billingCustomers", customer._id, { hold: true }));
    await expect(prepare(alice)).rejects.toThrow("FORBIDDEN");
    const bob = await user(t, "user_bob");
    await t.run(async ctx => {
      const row = (await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", "user_bob")).unique())!;
      await ctx.db.patch("users", row._id, { deletedAt: NOW });
    });
    await expect(prepare(bob)).rejects.toThrow("FORBIDDEN");
    expect(await customerOf(t, "user_bob")).toBeNull();
  });

  test("an active dispute hold refuses the resume of an open session and any new checkout until released", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_alice", checkoutUrl: URL_OK });
    const customer = (await customerOf(t, "user_alice"))!;
    const holdRef = await t.run(ctx => ctx.db.insert("billingAdjustments", {
      mode, customerRef: customer._id, paymentId: "pay_1", kind: "dispute", providerId: "dsp_1", status: "opened",
      countedMinor: 0, holdActive: true, observedAt: NOW,
    }));
    expect(await prepare(alice)).toEqual({ kind: "refused", code: "on_hold" });
    expect(await prepare(alice, "top_up")).toEqual({ kind: "refused", code: "on_hold" });
    await t.run(ctx => ctx.db.patch("billingCustomers", customer._id, { pendingPurchaseRef: undefined }));
    await expect(t.mutation(internal.billing.reservePurchase, {
      customerRef: customer._id, intentId: "intent_held",
      terms: { sku: "top_up", catalogVersion: BILLING_CATALOG_VERSION, productId: TOP_UP, quantity: 1, credits: 1000 },
    })).rejects.toThrow("FORBIDDEN");
    await t.run(ctx => ctx.db.patch("billingAdjustments", holdRef, { holdActive: false, status: "won" }));
    expect(await prepare(alice)).toMatchObject({ kind: "create_checkout" });
  });
});

describe("checkout lifecycle", () => {
  test("happy path: lease, customer, purchase from the catalog, session, then resume", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const customerRef = await readyCustomer(t, alice, "user_alice");
    expectRow(await t.run(ctx => ctx.db.get("billingCustomers", customerRef)), {
      customerId: "cus_user_alice", creationState: "ready", creationLeaseId: undefined, creationLeasedAt: undefined,
    });
    const { purchaseRef, intentId, customerId } = await reserved(t, alice, "user_alice");
    expect(customerId).toBe("cus_user_alice");
    expectRow(await purchaseOf(t, purchaseRef), {
      intentId, state: "preparing",
      terms: { sku: "pro_monthly", catalogVersion: BILLING_CATALOG_VERSION, productId: PRO, quantity: 1, credits: 2000 },
    });
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_alice", checkoutUrl: URL_OK, expiresAt: NOW + DAY });
    expectRow(await purchaseOf(t, purchaseRef), {
      state: "open", sessionId: "cks_alice", checkoutUrl: URL_OK, expiresAt: NOW + DAY, paymentId: undefined,
    });
    expect(await prepare(alice)).toEqual({ kind: "resume", checkoutUrl: URL_OK });
    // Another sku while one checkout is open waits; so does an expired session (only evidence releases the lock).
    expect(await prepare(alice, "top_up")).toEqual({ kind: "pending" });
    vi.setSystemTime(NOW + DAY + 1);
    expect(await prepare(alice)).toEqual({ kind: "pending" });
    expect((await customerOf(t, "user_alice"))!.pendingPurchaseRef).toBe(purchaseRef);
    expect(logs.flat().join(" ")).not.toContain("https://");
  });

  test("concurrent prepares take one lease; a stale lease becomes unknown and needs support", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const steps = await Promise.all([prepare(alice), prepare(alice)]);
    expect(steps.map(s => s.kind).sort()).toEqual(["create_customer", "pending"]);
    vi.setSystemTime(NOW + CUSTOMER_LEASE_STALE_MS + 1);
    expect(await prepare(alice)).toEqual({ kind: "refused", code: "support_required" });
    expectRow(await customerOf(t, "user_alice"), { creationState: "unknown" });
    expect(await prepare(alice)).toEqual({ kind: "refused", code: "support_required" });
  });

  test("customer results: lease mismatch conflicts, not_created re-leases, unknown needs support", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const first = await prepare(alice);
    if (first.kind !== "create_customer") throw new Error("expected lease");
    await expect(recordCustomer(alice, first.customerRef, "other_lease", { kind: "created", customerId: "cus_x" })).rejects.toThrow("CONFLICT");
    expect((await customerOf(t, "user_alice"))!.customerId).toBeUndefined();
    await recordCustomer(alice, first.customerRef, first.leaseId, { kind: "not_created" });
    const second = await prepare(alice);
    expect(second).toMatchObject({ kind: "create_customer" });
    if (second.kind !== "create_customer") return;
    expect(second.leaseId).not.toBe(first.leaseId);
    await recordCustomer(alice, second.customerRef, second.leaseId, { kind: "unknown" });
    expectRow(await customerOf(t, "user_alice"), { creationState: "unknown", creationLeaseId: second.leaseId });
    expect(await prepare(alice)).toEqual({ kind: "refused", code: "support_required" });
    // A late answer for the lost create still binds the real customer.
    await recordCustomer(alice, second.customerRef, second.leaseId, { kind: "created", customerId: "cus_user_alice" });
    expectRow(await customerOf(t, "user_alice"), { creationState: "ready", customerId: "cus_user_alice", creationLeaseId: undefined });
  });

  test("a created customer ID bound to another owner is never adopted", async () => {
    const t = setup();
    const bob = await user(t, "user_bob");
    await readyCustomer(t, bob, "user_shared");
    const alice = await user(t, "user_alice");
    const step = await prepare(alice);
    if (step.kind !== "create_customer") throw new Error("expected lease");
    await recordCustomer(alice, step.customerRef, step.leaseId, { kind: "created", customerId: "cus_user_shared" });
    expectRow(await customerOf(t, "user_alice"), { creationState: "unknown", customerId: undefined, creationLeaseId: step.leaseId });
    // The internal binding itself still refuses the duplicate.
    await expect(t.mutation(internal.billing.bindCustomer, { customerRef: step.customerRef, customerId: "cus_user_shared" })).rejects.toThrow("CONFLICT");
  });

  test("a malformed provider ID is recorded as unknown", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const step = await prepare(alice);
    if (step.kind !== "create_customer") throw new Error("expected lease");
    await recordCustomer(alice, step.customerRef, step.leaseId, { kind: "created", customerId: "cus bad/id" });
    expectRow(await customerOf(t, "user_alice"), { creationState: "unknown", customerId: undefined });
  });

  test("checkout unknown keeps the lock; a late created binds the session; not_created never applies to it", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    await recordCheckout(alice, purchaseRef, { kind: "unknown" });
    expectRow(await purchaseOf(t, purchaseRef), { state: "unknown" });
    expect(await prepare(alice)).toEqual({ kind: "pending" });
    await recordCheckout(alice, purchaseRef, { kind: "not_created" });
    expectRow(await purchaseOf(t, purchaseRef), { state: "unknown" });
    expect((await customerOf(t, "user_alice"))!.pendingPurchaseRef).toBe(purchaseRef);
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_late", checkoutUrl: URL_OK });
    expectRow(await purchaseOf(t, purchaseRef), { state: "open", sessionId: "cks_late", paymentId: undefined });
    await expect(recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_again" })).rejects.toThrow("CONFLICT");
  });

  test("checkout not_created marks the purchase terminal and releases the lock", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const first = await reserved(t, alice, "user_alice");
    await recordCheckout(alice, first.purchaseRef, { kind: "not_created" });
    expectRow(await purchaseOf(t, first.purchaseRef), { state: "terminal" });
    expect((await customerOf(t, "user_alice"))!.pendingPurchaseRef).toBeUndefined();
    const second = await reserved(t, alice, "user_alice");
    expect(second.purchaseRef).not.toBe(first.purchaseRef);
  });

  test("a stale preparing purchase becomes unknown with the lock kept; a late created still binds", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    expect(await prepare(alice)).toEqual({ kind: "pending" });
    expectRow(await purchaseOf(t, purchaseRef), { state: "preparing" });
    vi.setSystemTime(NOW + CHECKOUT_PREPARE_STALE_MS + 1);
    expect(await prepare(alice)).toEqual({ kind: "pending" });
    expectRow(await purchaseOf(t, purchaseRef), { state: "unknown" });
    expect((await customerOf(t, "user_alice"))!.nextPollAt).toBe(Date.now() + 15 * 60_000);
    expect((await customerOf(t, "user_alice"))!.pendingPurchaseRef).toBe(purchaseRef);
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_late", checkoutUrl: URL_OK });
    expect(await prepare(alice)).toEqual({ kind: "resume", checkoutUrl: URL_OK });
  });

  test.each([
    ["foreign host", "https://evil.example/session/cks"],
    ["http scheme", "http://test.checkout.dodopayments.com/session/cks"],
    ["live host in test mode", "https://checkout.dodopayments.com/session/cks"],
    ["credentials", "https://u:p@test.checkout.dodopayments.com/session/cks"],
    ["explicit port", "https://test.checkout.dodopayments.com:8443/session/cks"],
  ])("a checkout URL with a %s is not stored, but the session is", async (_name, checkoutUrl) => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "cks_alice", checkoutUrl });
    expectRow(await purchaseOf(t, purchaseRef), { state: "open", sessionId: "cks_alice", checkoutUrl: undefined });
    expect(await prepare(alice)).toEqual({ kind: "pending" });
    expect(logs.flat().join(" ")).not.toContain(checkoutUrl);
  });

  test("a malformed session ID is recorded as unknown", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const { purchaseRef } = await reserved(t, alice, "user_alice");
    await recordCheckout(alice, purchaseRef, { kind: "created", sessionId: "../cks", checkoutUrl: URL_OK });
    expectRow(await purchaseOf(t, purchaseRef), { state: "unknown", sessionId: undefined, checkoutUrl: undefined });
  });
});

describe("checkout refusals", () => {
  test.each([
    ["pending", {}],
    ["active", {}],
    ["quarantined", {}],
    ["cancelled", { paidThrough: NOW + DAY }],
  ] as const)("Pro is refused with a %s subscription", async (status, extra) => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const customerRef = await readyCustomer(t, alice, "user_alice");
    await t.run(ctx => ctx.db.insert("billingSubscriptions", { customerRef, mode, subscriptionId: "sub_1", productId: PRO, status, ...extra }));
    expect(await prepare(alice)).toEqual({ kind: "refused", code: "already_subscribed" });
    expect((await customerOf(t, "user_alice"))!.pendingPurchaseRef).toBeUndefined();
  });

  test("Pro is allowed after a cancelled subscription's paid period ended", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const customerRef = await readyCustomer(t, alice, "user_alice");
    await t.run(ctx => ctx.db.insert("billingSubscriptions", {
      customerRef, mode, subscriptionId: "sub_1", productId: PRO, status: "cancelled", paidThrough: NOW - 1,
    }));
    expect(await prepare(alice)).toMatchObject({ kind: "create_checkout" });
  });

  test("a Free user's top-up is refused before any customer lease", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    expect(await prepare(alice, "top_up")).toEqual({ kind: "refused", code: "not_pro" });
    expectRow(await customerOf(t, "user_alice"), { creationState: "preparing", creationLeaseId: undefined });
  });

  test("top-up in a paid period reserves catalog terms; the cap counts what allocation counts", async () => {
    const t = setup();
    const alice = await user(t, "user_alice");
    const customerRef = await readyCustomer(t, alice, "user_alice");
    await paidPeriod(t, customerRef, "user_alice");
    await topUpLots(t, customerRef, "user_alice", 100, true);
    await topUpLots(t, customerRef, "user_alice", 99, false);
    const { purchaseRef } = await reserved(t, alice, "user_alice", "top_up");
    expectRow(await purchaseOf(t, purchaseRef), {
      terms: { sku: "top_up", catalogVersion: BILLING_CATALOG_VERSION, productId: TOP_UP, quantity: 1, credits: 1000 },
    });
    await recordCheckout(alice, purchaseRef, { kind: "not_created" });
    await t.run(ctx => ctx.db.insert("billingGrants", {
      mode, sourceKey: "top_up:last", customerRef, userId: "user_alice", kind: "top_up", quantity: 1000, consumed: 0, revoked: 0, expiresAt: NOW + DAY,
    }));
    expect(await prepare(alice, "top_up")).toEqual({ kind: "refused", code: "top_up_cap" });
    // An expired lot no longer counts, exactly as allocation stops reading it.
    vi.setSystemTime(NOW + DAY);
    expect(await prepare(alice, "top_up")).toMatchObject({ kind: "create_checkout" });
  });

  test.each([
    ["the wrong mode", "pro_monthly", { mode: "live_mode" }, {}],
    ["a product outside Convex's catalog", "pro_monthly", { productId: "prod_other" }, {}],
    ["a top-up without a Convex top-up product", "top_up", {}, { DODO_PAYMENTS_TOP_UP_PRODUCT_ID: undefined }],
    ["absent Convex billing config", "pro_monthly", {}, { CODENAYA_DEPLOYMENT: undefined }],
    ["a misconfigured Convex catalog", "pro_monthly", {}, { DODO_PAYMENTS_PRO_PRODUCT_ID: "PLACEHOLDER_PRO" }],
  ] as const)("%s is refused as unavailable with nothing reserved", async (_name, sku, over, env) => {
    const t = setup();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const alice = await user(t, "user_alice");
    expect(await prepare(alice, sku, over)).toEqual({ kind: "refused", code: "unavailable" });
    expect(await customerOf(t, "user_alice")).toBeNull();
    expect(await t.run(ctx => ctx.db.query("billingPurchases").take(1))).toEqual([]);
  });
});

describe("isDodoCheckoutUrl", () => {
  test("accepts only https on the mode's exact checkout host", () => {
    expect(isDodoCheckoutUrl("test_mode", URL_OK)).toBe(true);
    expect(isDodoCheckoutUrl("live_mode", "https://checkout.dodopayments.com/session/cks")).toBe(true);
    expect(isDodoCheckoutUrl("live_mode", URL_OK)).toBe(false);
    expect(isDodoCheckoutUrl("live_mode", "https://checkout.dodopayments.com.evil.example/x")).toBe(false);
    expect(isDodoCheckoutUrl("test_mode", "not a url")).toBe(false);
  });
});
