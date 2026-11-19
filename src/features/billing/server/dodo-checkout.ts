// Server-only Dodo creates for checkout. One attempt each, never retried: no idempotency is
// verified for either create, so a lost answer is `unknown` and the caller keeps the lock.
// Field names follow the dodopayments SDK 2.63.0 types (customers.ts, checkout-sessions.ts).
import { isDodoCheckoutUrl } from "../checkout-url";
import type { DodoNextConfig } from "./dodo-config";
import { DodoReadError, PERMANENT_STATUSES, PROVIDER_ID, readJson, type Json } from "./dodo-reads";

export type CreateResult<T> = { kind: "created"; value: T } | { kind: "not_created" } | { kind: "unknown" };
export type CheckoutSku = "pro_monthly" | "top_up";

/** A definite 4xx means nothing was created; everything else (network, timeout, 408/409/429, 5xx,
 * a redirect, a malformed 2xx) may have created something. */
async function create<T>(
  config: DodoNextConfig, path: string, body: Json, fetchImpl: typeof fetch, parse: (body: Json) => T | null,
): Promise<CreateResult<T>> {
  let response: Json;
  try {
    response = await readJson(config, path, fetchImpl, body);
  } catch (error) {
    const definite = error instanceof DodoReadError && error.status !== undefined && PERMANENT_STATUSES.has(error.status);
    return { kind: definite ? "not_created" : "unknown" };
  }
  const value = parse(response);
  return value ? { kind: "created", value } : { kind: "unknown" };
}

const providerId = (value: unknown) => (typeof value === "string" && PROVIDER_ID.test(value) ? value : null);

export function createDodoCustomer(
  config: DodoNextConfig, input: { email: string; name: string }, fetchImpl: typeof fetch = fetch,
): Promise<CreateResult<{ customerId: string }>> {
  return create(config, "/customers", { email: input.email, name: input.name }, fetchImpl, body => {
    const customerId = providerId(body.customer_id);
    return customerId && body.business_id === config.businessId ? { customerId } : null;
  });
}

export function createDodoCheckout(
  config: DodoNextConfig,
  input: { customerId: string; productId: string; intentId: string; sku: CheckoutSku },
  fetchImpl: typeof fetch = fetch,
): Promise<CreateResult<{ sessionId: string; checkoutUrl?: string }>> {
  // Everything here is server-chosen. 2.63.0 has no checkout `brand_id` and no session expiry.
  const body = {
    product_cart: [{ product_id: input.productId, quantity: 1 }],
    customer: { customer_id: input.customerId },
    return_url: config.returnUrl,
    metadata: { purchaseId: input.intentId, purpose: input.sku },
    feature_flags: { allow_discount_code: false },
  };
  return create(config, "/checkouts", body, fetchImpl, response => {
    const sessionId = providerId(response.session_id);
    if (!sessionId) return null;
    const url = response.checkout_url;
    // A URL off the mode's checkout host is never handed to the browser; the session still counts.
    return typeof url === "string" && isDodoCheckoutUrl(config.environment, url)
      ? { sessionId, checkoutUrl: url }
      : { sessionId };
  });
}
