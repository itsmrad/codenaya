import { describe, expect, it, vi } from "vitest";

import { CHECKOUT_HOSTS } from "../checkout-url";
import { createDodoCheckout, createDodoCustomer } from "./dodo-checkout";
import type { DodoNextConfig } from "./dodo-config";

const KEY = "synthetic-next-key";
const config: DodoNextConfig = {
  environment: "test_mode", businessId: "bus_1", apiKey: KEY, proProductId: "prod_pro",
  brandId: "brand_1", returnUrl: "http://localhost:3100/settings/billing/return", topUpsEnabled: false,
};
const CHECKOUT_URL = `https://${CHECKOUT_HOSTS.test_mode}/session/cks_1`;
const checkoutInput = { customerId: "cus_1", productId: "prod_pro", intentId: "intent_1", sku: "pro_monthly" } as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchReturning = (response: Response | Error) =>
  vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
const sentBody = (fetchImpl: ReturnType<typeof fetchReturning>) =>
  JSON.parse(fetchImpl.mock.calls[0][1]?.body as string) as Record<string, unknown>;

describe("createDodoCustomer", () => {
  it("posts only email and name to the mode's host with the bearer key, without following redirects", async () => {
    const fetchImpl = fetchReturning(json({ customer_id: "cus_1", business_id: "bus_1", email: "a@x.test", name: "A" }));
    const result = await createDodoCustomer(config, { email: "a@x.test", name: "A" }, fetchImpl);
    expect(result).toEqual({ kind: "created", value: { customerId: "cus_1" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://test.dodopayments.com/customers");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    expect(sentBody(fetchImpl)).toEqual({ email: "a@x.test", name: "A" });
  });

  it("treats a customer of another business or a malformed id as unknown", async () => {
    for (const body of [{ customer_id: "cus_1", business_id: "bus_other" }, { customer_id: "bad id", business_id: "bus_1" }]) {
      expect(await createDodoCustomer(config, { email: "a@x.test", name: "A" }, fetchReturning(json(body))))
        .toEqual({ kind: "unknown" });
    }
  });
});

describe("createDodoCheckout", () => {
  it("sends only server-chosen fields: product, quantity 1, customer, fixed return URL, metadata, no discount codes", async () => {
    const fetchImpl = fetchReturning(json({ session_id: "cks_1", checkout_url: CHECKOUT_URL }));
    const result = await createDodoCheckout(config, checkoutInput, fetchImpl);
    expect(result).toEqual({ kind: "created", value: { sessionId: "cks_1", checkoutUrl: CHECKOUT_URL } });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://test.dodopayments.com/checkouts");
    expect(sentBody(fetchImpl)).toEqual({
      product_cart: [{ product_id: "prod_pro", quantity: 1 }],
      customer: { customer_id: "cus_1" },
      return_url: config.returnUrl,
      metadata: { purchaseId: "intent_1", purpose: "pro_monthly" },
      feature_flags: { allow_discount_code: false },
    });
  });

  it.each([400, 401, 403, 404, 422])("a definite %i means not created", async status => {
    const fetchImpl = fetchReturning(json({ message: "nope" }, status));
    expect(await createDodoCheckout(config, checkoutInput, fetchImpl)).toEqual({ kind: "not_created" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["a network error", new TypeError("fetch failed")],
    ["a timeout", new DOMException("aborted", "AbortError")],
    ["408", json({}, 408)], ["409", json({}, 409)], ["429", json({}, 429)], ["500", json({}, 500)], ["503", json({}, 503)],
    ["a redirect", new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } })],
    ["a malformed 2xx", new Response("not json", { status: 200 })],
    ["a 2xx without a session id", json({ checkout_url: CHECKOUT_URL })],
  ])("%s is unknown and never retried", async (_label, response) => {
    const fetchImpl = fetchReturning(response);
    expect(await createDodoCheckout(config, checkoutInput, fetchImpl)).toEqual({ kind: "unknown" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["a foreign host", "https://evil.test/session/cks_1"],
    ["http", `http://${CHECKOUT_HOSTS.test_mode}/session/cks_1`],
    ["the live host in test mode", `https://${CHECKOUT_HOSTS.live_mode}/session/cks_1`],
  ])("withholds a checkout URL on %s but keeps the session", async (_label, url) => {
    const result = await createDodoCheckout(config, checkoutInput, fetchReturning(json({ session_id: "cks_1", checkout_url: url })));
    expect(result).toEqual({ kind: "created", value: { sessionId: "cks_1" } });
  });
});
