import { describe, expect, it } from "vitest";

import { PLANS, TOP_UP } from "./plans";
import { decideSettlement, type ProviderPayment, type ProviderSubscription } from "./settlement";

const START = Date.parse("2026-11-01T00:00:00Z");
const END = Date.parse("2026-12-01T00:00:00Z");
const CREATED = Date.parse("2026-11-01T00:00:05Z");
const catalog = { proProductId: "prod_pro", topUpProductId: "prod_topup" };

// SDK 2.63.0: `product_cart` lists one-time products only, so a pure Pro charge has an empty cart.
const proPayment = (overrides: Partial<ProviderPayment> = {}): ProviderPayment => ({
  paymentId: "pay_1", businessId: "bus_1", customerId: "cus_alice", status: "succeeded",
  subscriptionId: "sub_1", cart: [],
  totalMinor: 2000, taxMinor: 0, currency: "USD", createdAt: CREATED, chargeType: "new",
  servicePeriods: [{ subscriptionId: "sub_1", start: START, end: END, prorationFactor: "1" }],
  ...overrides,
});
const subscription = (overrides: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  subscriptionId: "sub_1", customerId: "cus_alice", productId: "prod_pro", quantity: 1, status: "active",
  previousBillingAt: START, nextBillingAt: END, cancelAtNextBillingDate: false, ...overrides,
});
const topUp = (overrides: Partial<ProviderPayment> = {}) => proPayment({
  subscriptionId: undefined, chargeType: undefined, servicePeriods: [],
  cart: [{ productId: "prod_topup", quantity: 1 }], totalMinor: 1000, ...overrides,
});
const decide = (payment: ProviderPayment, sub: ProviderSubscription | null = subscription()) =>
  decideSettlement({ payment, subscription: sub, customerId: "cus_alice", catalog });

describe("decideSettlement", () => {
  it("grants one full Pro period from a settled payment", () => {
    expect(decide(proPayment())).toEqual({
      kind: "period", paymentId: "pay_1", subscriptionId: "sub_1", productId: "prod_pro",
      serviceStart: START, serviceEnd: END, credits: PLANS.pro.monthlyCredits, settledAt: CREATED,
    });
  });
  it("gives the first period and a renewal the same period fields for the same payment", () => {
    // payment.succeeded and subscription.renewed both lead to reading the same payment.
    const first = decide(proPayment());
    expect(decide(proPayment())).toEqual(first);
    const renewal = decide(proPayment({ chargeType: "renewal" }));
    expect(renewal).toEqual(first);
  });
  it("accepts the Pro product listed once in the cart", () => {
    expect(decide(proPayment({ cart: [{ productId: "prod_pro", quantity: 1 }] })))
      .toMatchObject({ kind: "period", productId: "prod_pro", credits: PLANS.pro.monthlyCredits });
  });
  it("picks the period of the payment's own subscription", () => {
    expect(decide(proPayment({ servicePeriods: [
      { subscriptionId: "sub_other", start: 1, end: 2, prorationFactor: "1" },
      { subscriptionId: "sub_1", start: START, end: END, prorationFactor: "1.0" },
    ] }))).toMatchObject({ kind: "period", serviceStart: START, serviceEnd: END });
  });

  it("quarantines a payment from another customer before anything else", () => {
    expect(decide(proPayment({ customerId: "cus_bob" }))).toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "customer_mismatch" });
    expect(decide(proPayment({ customerId: "cus_bob", status: "failed" }))).toMatchObject({ reason: "customer_mismatch" });
  });
  it.each([
    ["processing", { kind: "processing", paymentId: "pay_1" }],
    ["other", { kind: "processing", paymentId: "pay_1" }],
    ["failed", { kind: "no_grant", paymentId: "pay_1", reason: "failed" }],
    ["cancelled", { kind: "no_grant", paymentId: "pay_1", reason: "cancelled" }],
  ] as const)("records a %s payment without a grant", (status, expected) => {
    expect(decide(proPayment({ status }))).toEqual(expected);
  });
  it.each([
    ["an empty cart", []],
    ["two lines", [{ productId: "prod_topup", quantity: 1 }, { productId: "prod_topup", quantity: 1 }]],
    ["quantity 2", [{ productId: "prod_topup", quantity: 2 }]],
    ["quantity 0", [{ productId: "prod_topup", quantity: 0 }]],
  ])("quarantines a one-time payment with %s", (_, cart) => {
    expect(decide(topUp({ cart }), null)).toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "cart" });
  });
  it.each([
    ["a bundled one-time product", [{ productId: "prod_pro", quantity: 1 }, { productId: "prod_topup", quantity: 1 }]],
    ["Pro with quantity 2", [{ productId: "prod_pro", quantity: 2 }]],
    ["the top-up product", [{ productId: "prod_topup", quantity: 1 }]],
  ])("quarantines a subscription charge with %s in the cart, never a top-up", (_, cart) => {
    expect(decide(proPayment({ cart }))).toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "cart" });
    expect(decide(proPayment({ cart, chargeType: undefined }))).toMatchObject({ kind: "quarantine", reason: "cart" });
    expect(decide(proPayment({ cart, subscriptionId: undefined }))).toMatchObject({ kind: "quarantine", reason: "cart" });
  });
  it.each([2, 0, undefined])("quarantines a Pro subscription with quantity %s", (quantity) => {
    expect(decide(proPayment(), subscription({ quantity })))
      .toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "cart" });
  });
  it.each([
    ["a zero amount", { totalMinor: 0 }],
    ["a negative amount", { totalMinor: -1 }],
    ["no currency", { currency: "" }],
  ])("quarantines %s", (_, overrides) => {
    expect(decide(proPayment(overrides))).toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "amount" });
    expect(decide(topUp(overrides))).toMatchObject({ reason: "amount" });
  });

  it("grants a top-up settled at the provider's time, stable on replay", () => {
    const decision = decide(topUp(), null);
    expect(decision).toEqual({ kind: "top_up", paymentId: "pay_1", productId: "prod_topup", credits: TOP_UP.credits, settledAt: CREATED });
    expect(decide(topUp(), null)).toEqual(decision);
  });
  it("quarantines a top-up product when top-ups are not configured", () => {
    expect(decideSettlement({ payment: topUp(), subscription: null, customerId: "cus_alice", catalog: { proProductId: "prod_pro" } }))
      .toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "unknown_product" });
  });
  it("quarantines an unknown product", () => {
    expect(decide(topUp({ cart: [{ productId: "prod_other", quantity: 1 }] }), null))
      .toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "unknown_product" });
    // Pro bought without a subscription is not a one-time product.
    expect(decide(topUp({ cart: [{ productId: "prod_pro", quantity: 1 }] }), null))
      .toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "unknown_product" });
    expect(decide(proPayment(), subscription({ productId: "prod_other" })))
      .toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "unknown_product" });
  });

  it.each([
    ["no subscription id", proPayment({ subscriptionId: undefined }), subscription()],
    ["no subscription read", proPayment(), null],
    ["another subscription", proPayment(), subscription({ subscriptionId: "sub_2" })],
    ["a subscription owned by someone else", proPayment(), subscription({ customerId: "cus_bob" })],
  ])("quarantines a Pro payment with %s", (_, payment, sub) => {
    expect(decide(payment, sub)).toEqual({ kind: "quarantine", paymentId: "pay_1", reason: "subscription_mismatch" });
  });

  it.each(["plan_change", "on_demand"])("excludes the %s charge type", (chargeType) => {
    expect(decide(proPayment({ chargeType }))).toEqual({ kind: "no_grant", paymentId: "pay_1", reason: "not_full_period" });
  });
  it.each(["0.5", "0.25"])("excludes a prorated period (%s)", (prorationFactor) => {
    expect(decide(proPayment({ servicePeriods: [{ subscriptionId: "sub_1", start: START, end: END, prorationFactor }] })))
      .toEqual({ kind: "no_grant", paymentId: "pay_1", reason: "not_full_period" });
  });
  it("excludes a usage-only renewal that has no service period", () => {
    expect(decide(proPayment({ chargeType: "renewal", servicePeriods: [], includesUsage: true })))
      .toEqual({ kind: "no_grant", paymentId: "pay_1", reason: "not_full_period" });
  });
  it.each([false, undefined])("keeps a renewal with no period and includes_usage %s pending", (includesUsage) => {
    expect(decide(proPayment({ chargeType: "renewal", servicePeriods: [], includesUsage })))
      .toEqual({ kind: "pending", paymentId: "pay_1", reason: "service_period_unknown" });
  });
  it.each([
    ["a zero-amount", { totalMinor: 0, cart: [], chargeType: undefined, servicePeriods: [] }],
    ["a nonzero", { totalMinor: 100, chargeType: undefined, servicePeriods: [] }],
    ["a failed", { status: "failed" as const }],
    ["a cart-listed", { cart: [{ productId: "prod_topup", quantity: 3 }] }],
  ])("records %s card update as a final non-grant", (_, overrides) => {
    expect(decide(proPayment({ isUpdatePaymentMethod: true, ...overrides })))
      .toEqual({ kind: "no_grant", paymentId: "pay_1", reason: "payment_method_update" });
    expect(decide(proPayment({ isUpdatePaymentMethod: true, ...overrides, customerId: "cus_bob" })))
      .toMatchObject({ kind: "quarantine", reason: "customer_mismatch" });
  });
  it.each(["usage", "other", "NEW"])("keeps an unknown charge type pending, even on a one-time top-up line (%s)", (chargeType) => {
    // e.g. a multi-subscription payment: no subscription_id, one one-time line, a new charge type.
    expect(decide(topUp({ chargeType }), null))
      .toEqual({ kind: "pending", paymentId: "pay_1", reason: "charge_type_unknown" });
    expect(decide(topUp({ chargeType: undefined }), null)).toMatchObject({ kind: "top_up", credits: TOP_UP.credits });
  });
  it.each([undefined, "usage", "NEW"])("keeps a missing or unknown charge type pending (%s)", (chargeType) => {
    expect(decide(proPayment({ chargeType }))).toEqual({ kind: "pending", paymentId: "pay_1", reason: "charge_type_unknown" });
  });
  it.each([
    ["missing service_periods", undefined],
    ["no period for a new charge", []],
    ["two periods for the subscription", [
      { subscriptionId: "sub_1", start: START, end: END, prorationFactor: "1" },
      { subscriptionId: "sub_1", start: END, end: END + 1, prorationFactor: "1" },
    ]],
    ["an empty period", [{ subscriptionId: "sub_1", start: END, end: END, prorationFactor: "1" }]],
    ["a reversed period", [{ subscriptionId: "sub_1", start: END, end: START, prorationFactor: "1" }]],
    ["a factor above one", [{ subscriptionId: "sub_1", start: START, end: END, prorationFactor: "2" }]],
    ["a zero factor", [{ subscriptionId: "sub_1", start: START, end: END, prorationFactor: "0" }]],
  ])("keeps %s pending, never guessed", (_, servicePeriods) => {
    expect(decide(proPayment({ servicePeriods })))
      .toEqual({ kind: "pending", paymentId: "pay_1", reason: "service_period_unknown" });
  });
});
