import { afterEach, describe, expect, it, vi } from "vitest";

import type { DodoReconcilerConfig } from "./dodo-config";
import {
  DODO_READ_TIMEOUT_MS, DodoReadError, MAX_PROVIDER_BODY_BYTES, fetchCheckoutSession, fetchPayment, fetchSubscription,
  listCustomerResources,
} from "./dodo-reads";

const KEY = "synthetic-reconciler-key";
const config: DodoReconcilerConfig = {
  environment: "test_mode", businessId: "bus_1", apiKey: KEY, proProductId: "prod_pro",
};

// Shapes follow dodopayments SDK 2.63.0 `Payment` and `Subscription`.
const paymentBody = (overrides: Record<string, unknown> = {}) => ({
  payment_id: "pay_1", business_id: "bus_1", status: "succeeded", total_amount: 2000, tax: 180,
  currency: "USD", created_at: "2026-11-01T00:00:05Z",
  customer: { customer_id: "cus_alice", email: "alice@example.com", name: "Alice" },
  subscription_id: "sub_1", checkout_session_id: "cks_1",
  // A subscription charge lists one-time products only.
  product_cart: null,
  charge_type: "new", includes_usage: false, is_update_payment_method: false,
  service_periods: [{
    subscription_id: "sub_1", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z", proration_factor: "1",
  }],
  ...overrides,
});
const subscriptionBody = (overrides: Record<string, unknown> = {}) => ({
  subscription_id: "sub_1", status: "active", product_id: "prod_pro", quantity: 1,
  customer: { customer_id: "cus_alice", email: "alice@example.com", name: "Alice" },
  previous_billing_date: "2026-11-01T00:00:00Z", next_billing_date: "2026-12-01T00:00:00Z",
  cancel_at_next_billing_date: false, ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchReturning = (response: Response | (() => Promise<Response>)) =>
  vi.fn<typeof fetch>(async () => (typeof response === "function" ? response() : response));

async function failure(promise: Promise<unknown>): Promise<DodoReadError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DodoReadError);
  const text = String(error) + (error as Error).stack + JSON.stringify(error);
  for (const secret of [KEY, "alice@example.com", "dodopayments.com", "pay_1", "sub_1"]) {
    expect(text).not.toContain(secret);
  }
  return error as DodoReadError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Dodo reads", () => {
  it.each([
    ["test_mode", "https://test.dodopayments.com"],
    ["live_mode", "https://live.dodopayments.com"],
  ] as const)("reads %s from its fixed host with the bearer key and no redirects", async (environment, host) => {
    const fetchImpl = fetchReturning(json(paymentBody()));
    await fetchPayment({ ...config, environment }, "pay_1", fetchImpl);
    const subscriptionFetch = fetchReturning(json(subscriptionBody()));
    await fetchSubscription({ ...config, environment }, "sub_1", subscriptionFetch);
    expect(fetchImpl).toHaveBeenCalledWith(`${host}/payments/pay_1`, expect.objectContaining({
      method: "GET", redirect: "manual", headers: expect.objectContaining({ Authorization: `Bearer ${KEY}` }),
    }));
    expect(subscriptionFetch.mock.calls[0][0]).toBe(`${host}/subscriptions/sub_1`);
    expect(subscriptionFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  });

  it("normalizes a payment with parsed dates", async () => {
    expect(await fetchPayment(config, "pay_1", fetchReturning(json(paymentBody())))).toEqual({
      paymentId: "pay_1", businessId: "bus_1", customerId: "cus_alice", status: "succeeded",
      subscriptionId: "sub_1", sessionId: "cks_1", cart: [],
      totalMinor: 2000, taxMinor: 180, currency: "USD", createdAt: Date.parse("2026-11-01T00:00:05Z"),
      chargeType: "new",
      servicePeriods: [{
        subscriptionId: "sub_1", start: Date.parse("2026-11-01T00:00:00Z"), end: Date.parse("2026-12-01T00:00:00Z"),
        prorationFactor: "1",
      }],
      includesUsage: false, isUpdatePaymentMethod: false,
    });
    const read = await fetchPayment(config, "pay_1", fetchReturning(json(paymentBody({
      product_cart: [{ product_id: "prod_topup", quantity: 2 }], includes_usage: true, is_update_payment_method: true,
    }))));
    expect(read).toMatchObject({
      cart: [{ productId: "prod_topup", quantity: 2 }], includesUsage: true, isUpdatePaymentMethod: true,
    });
  });
  it("keeps unknown or missing provider facts unknown rather than guessed", async () => {
    const payment = await fetchPayment(config, "pay_1", fetchReturning(json(paymentBody({
      status: "requires_customer_action", tax: null, currency: null, charge_type: null, subscription_id: null,
      checkout_session_id: undefined, product_cart: null, service_periods: undefined,
      includes_usage: "true", is_update_payment_method: undefined,
    }))));
    expect(payment).toMatchObject({ status: "other", taxMinor: undefined, currency: "", cart: [] });
    expect(payment.includesUsage).toBeUndefined();
    expect(payment.isUpdatePaymentMethod).toBeUndefined();
    expect(payment.chargeType).toBeUndefined();
    expect(payment.subscriptionId).toBeUndefined();
    expect(payment.servicePeriods).toBeUndefined();
    for (const periods of [
      [{ subscription_id: "sub_1", starts_at: "not-a-date", ends_at: "2026-12-01T00:00:00Z", proration_factor: "1" }],
      [{ subscription_id: "sub_1", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" }],
      [{ subscription_id: "bad id", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z", proration_factor: "1" }],
      "2026-11-01",
    ]) {
      const read = await fetchPayment(config, "pay_1", fetchReturning(json(paymentBody({ service_periods: periods }))));
      expect(read.servicePeriods).toBeUndefined();
    }
  });
  it.each(["Nov 1 2026", "2026", "2026-11-01", "2026-11-01T00:00:00", "2026-13-01T00:00:00Z", "1730419200000"])(
    "accepts only ISO-8601 dates with a zone (%s is absent)", async (date) => {
      const read = await fetchSubscription(config, "sub_1", fetchReturning(json(subscriptionBody({ previous_billing_date: date }))));
      expect(read.previousBillingAt).toBeUndefined();
      expect(await failure(fetchPayment(config, "pay_1", fetchReturning(json(paymentBody({ created_at: date }))))))
        .toMatchObject({ retryable: false });
    },
  );
  it("accepts ISO-8601 dates with fractions and offsets", async () => {
    const read = await fetchSubscription(config, "sub_1", fetchReturning(json(subscriptionBody({
      previous_billing_date: "2026-11-01T05:30:00.123456+05:30",
    }))));
    expect(read.previousBillingAt).toBe(Date.parse("2026-11-01T00:00:00.123Z"));
  });
  it.each(["NEW", "x".repeat(40), 42, true, {}])("keeps an unrecognised charge type unknown, not absent (%s)", async (charge) => {
    const read = await fetchPayment(config, "pay_1", fetchReturning(json(paymentBody({ charge_type: charge }))));
    expect(read.chargeType).toBe("other");
  });
  it("normalizes an unrecognised but well-formed charge type as itself", async () => {
    const read = await fetchPayment(config, "pay_1", fetchReturning(json(paymentBody({ charge_type: "usage_settlement" }))));
    expect(read.chargeType).toBe("usage_settlement");
  });
  it("normalizes a subscription and treats an invalid date as absent", async () => {
    expect(await fetchSubscription(config, "sub_1", fetchReturning(json(subscriptionBody({
      status: "past_due", next_billing_date: "soon", cancel_at_next_billing_date: true,
    }))))).toEqual({
      subscriptionId: "sub_1", customerId: "cus_alice", productId: "prod_pro", quantity: 1, status: "other",
      previousBillingAt: Date.parse("2026-11-01T00:00:00Z"), nextBillingAt: undefined, cancelAtNextBillingDate: true,
    });
  });

  it.each([429, 503, 500, 408])("treats HTTP %s as retryable", async (status) => {
    const error = await failure(fetchPayment(config, "pay_1", fetchReturning(json({ message: KEY }, status))));
    expect(error).toMatchObject({ retryable: true, status });
  });
  it.each([404, 401, 403, 400, 422])("treats HTTP %s as permanent", async (status) => {
    const error = await failure(fetchSubscription(config, "sub_1", fetchReturning(json({ message: KEY }, status))));
    expect(error).toMatchObject({ retryable: false, status });
  });
  it("treats a network failure as retryable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed: https://test.dodopayments.com/payments/pay_1?key=${KEY}`);
    });
    expect(await failure(fetchPayment(config, "pay_1", fetchImpl))).toMatchObject({ retryable: true });
  });
  it.each([301, 302, 307, 308])("never follows a %s redirect and treats it as permanent", async (status) => {
    const redirect = new Response(null, { status, headers: { location: "https://evil.test/payments/pay_1" } });
    const fetchImpl = fetchReturning(redirect);
    expect(await failure(fetchPayment(config, "pay_1", fetchImpl))).toMatchObject({ retryable: false, status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("treats an opaque redirect as permanent", async () => {
    const opaque = { ok: false, status: 0, type: "opaqueredirect", body: null, headers: new Headers() } as unknown as Response;
    expect(await failure(fetchPayment(config, "pay_1", fetchReturning(opaque)))).toMatchObject({ retryable: false });
  });
  it.each([503, 404])("cancels the body of an HTTP %s response", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull: controller => controller.enqueue(new TextEncoder().encode(KEY)), cancel });
    await failure(fetchPayment(config, "pay_1", fetchReturning(new Response(body, { status }))));
    expect(cancel).toHaveBeenCalled();
  });
  it("aborts a read that exceeds the timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const read = failure(fetchPayment(config, "pay_1", fetchImpl));
    await vi.advanceTimersByTimeAsync(DODO_READ_TIMEOUT_MS - 1);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toMatchObject({ retryable: true });
  });

  it("rejects an oversize body, declared or streamed", async () => {
    const big = JSON.stringify(paymentBody({ padding: "x".repeat(MAX_PROVIDER_BODY_BYTES) }));
    const declared = new Response("{}", { headers: { "content-length": String(MAX_PROVIDER_BODY_BYTES + 1) } });
    expect(await failure(fetchPayment(config, "pay_1", fetchReturning(declared)))).toMatchObject({ retryable: false });
    expect(await failure(fetchPayment(config, "pay_1", fetchReturning(new Response(big))))).toMatchObject({ retryable: false });
  });
  it.each([
    ["another business", paymentBody({ business_id: "bus_other" })],
    ["another payment id", paymentBody({ payment_id: "pay_2" })],
    ["an oversize customer id", paymentBody({ customer: { customer_id: "c".repeat(129) } })],
    ["a malformed customer", paymentBody({ customer: null })],
    ["a non-integer amount", paymentBody({ total_amount: 20.5 })],
    ["an unsafe amount", paymentBody({ total_amount: 2 ** 60 })],
    ["a malformed cart", paymentBody({ product_cart: [{ product_id: "prod_pro", quantity: "1" }] })],
    ["a malformed subscription id", paymentBody({ subscription_id: "sub/../1" })],
    ["an invalid creation date", paymentBody({ created_at: "yesterday" })],
    ["a non-object body", ["not", "a", "payment"]],
  ])("treats a payment with %s as permanent", async (_, body) => {
    expect(await failure(fetchPayment(config, "pay_1", fetchReturning(json(body))))).toMatchObject({ retryable: false });
  });
  it("treats invalid JSON as permanent", async () => {
    expect(await failure(fetchPayment(config, "pay_1", fetchReturning(new Response("{not json")))))
      .toMatchObject({ retryable: false });
  });
  it.each([
    ["another subscription id", subscriptionBody({ subscription_id: "sub_2" })],
    ["a missing product", subscriptionBody({ product_id: undefined })],
    ["a non-integer quantity", subscriptionBody({ quantity: 1.5 })],
    ["a non-boolean cancel flag", subscriptionBody({ cancel_at_next_billing_date: "false" })],
  ])("treats a subscription with %s as permanent", async (_, body) => {
    expect(await failure(fetchSubscription(config, "sub_1", fetchReturning(json(body))))).toMatchObject({ retryable: false });
  });
  it("refuses a malformed or oversize id without calling Dodo", async () => {
    const fetchImpl = fetchReturning(json(paymentBody()));
    for (const id of ["pay/1", "../payments", "", "p".repeat(129)]) {
      expect(await failure(fetchPayment(config, id, fetchImpl))).toMatchObject({ retryable: false });
      expect(await failure(fetchSubscription(config, id, fetchImpl))).toMatchObject({ retryable: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Dodo list and checkout reads", () => {
  const SINCE = Date.parse("2026-11-01T00:00:00Z");
  const item = (overrides: Record<string, unknown> = {}) => ({
    payment_id: "pay_1", refund_id: "ref_1", dispute_id: "dsp_1", subscription_id: "sub_1", status: "succeeded",
    dispute_status: "dispute_opened", created_at: "2026-11-02T00:00:00Z", customer: { customer_id: "cus_alice" }, ...overrides,
  });

  it("lists one bounded page by customer and creation time, keeping ids and status only", async () => {
    const fetchImpl = fetchReturning(json({ items: [item(), item({ refund_id: "ref_2", status: "Weird Status" })] }));
    const page = await listCustomerResources(config, "refunds", "cus_alice", SINCE, fetchImpl);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://test.dodopayments.com/refunds?customer_id=cus_alice&created_at_gte=2026-11-01T00%3A00%3A00.000Z&page_size=20");
    expect(page).toEqual({
      full: false,
      items: [
        { id: "ref_1", status: "succeeded", createdAt: Date.parse("2026-11-02T00:00:00Z"), paymentId: "pay_1" },
        { id: "ref_2", status: "other", createdAt: Date.parse("2026-11-02T00:00:00Z"), paymentId: "pay_1" },
      ],
    });
    const disputes = await listCustomerResources(config, "disputes", "cus_alice", SINCE, fetchReturning(json({ items: [item()] })));
    expect(disputes.items[0]).toMatchObject({ id: "dsp_1", status: "dispute_opened", paymentId: "pay_1" });
  });

  it("flags a full page and fails closed on another customer's item or a malformed list", async () => {
    const full = await listCustomerResources(config, "payments", "cus_alice", SINCE,
      fetchReturning(json({ items: Array.from({ length: 20 }, (_, i) => item({ payment_id: `pay_${i}` })) })));
    expect(full.full).toBe(true);
    await failure(listCustomerResources(config, "subscriptions", "cus_alice", SINCE, fetchReturning(json({ items: [item({ customer: { customer_id: "cus_bob" } })] }))));
    await failure(listCustomerResources(config, "payments", "cus_alice", SINCE, fetchReturning(json({ items: Array(21).fill(item()) }))));
    await failure(listCustomerResources(config, "payments", "cus_alice", SINCE, fetchReturning(json({ items: [item({ created_at: "soon" })] }))));
    expect((await failure(listCustomerResources(config, "payments", "cus_alice", SINCE, fetchReturning(json({}, 503)))))).toMatchObject({ retryable: true });
  });

  it("reads a checkout session's creation time and payment", async () => {
    const fetchImpl = fetchReturning(json({ id: "cks_1", created_at: "2026-11-02T00:00:00Z", payment_id: null, payment_status: null }));
    expect(await fetchCheckoutSession(config, "cks_1", fetchImpl)).toEqual({ createdAt: Date.parse("2026-11-02T00:00:00Z") });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://test.dodopayments.com/checkouts/cks_1");
    expect(await fetchCheckoutSession(config, "cks_1", fetchReturning(json({ id: "cks_1", created_at: "2026-11-02T00:00:00Z", payment_id: "pay_1", payment_status: "processing" }))))
      .toMatchObject({ paymentId: "pay_1", paymentStatus: "processing" });
    await failure(fetchCheckoutSession(config, "cks_1", fetchReturning(json({ id: "cks_2", created_at: "2026-11-02T00:00:00Z" }))));
  });
});
