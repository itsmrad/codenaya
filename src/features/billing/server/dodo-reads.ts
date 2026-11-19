// Server-only Dodo reads for reconciliation. Errors carry a fixed message and the HTTP status
// only: never the key, URL or body. Field names follow the dodopayments SDK 2.63.0 types.
import type { ProviderPayment, ProviderSubscription } from "../settlement";
import { readBoundedBody } from "./bounded-body";
import type { DodoEnvironment, DodoReconcilerConfig } from "./dodo-config";

export const DODO_READ_TIMEOUT_MS = 15_000;
export const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
const MAX_LIST_ITEMS = 20;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURRENCY = /^[A-Z]{3}$/;
const CHARGE_TYPE = /^[a-z_]{1,32}$/;
const PRORATION_FACTOR = /^\d{1,6}(\.\d{1,12})?$/;
// ISO-8601 with an explicit zone only; Date.parse alone also accepts loose text like "Nov 1 2026".
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// The host comes from the validated mode alone (ADR 0016: no base-URL override).
const BASE_URL: Record<DodoEnvironment, string> = {
  test_mode: "https://test.dodopayments.com",
  live_mode: "https://live.dodopayments.com",
};
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);
const PAYMENT_STATUSES = new Set(["succeeded", "processing", "failed", "cancelled"]);
const SUBSCRIPTION_STATUSES = new Set(["pending", "active", "on_hold", "paused", "cancelled", "failed", "expired"]);

export class DodoReadError extends Error {
  constructor(readonly retryable: boolean, readonly status?: number) {
    super(retryable ? "Dodo read failed; retry later." : "Dodo read failed permanently.");
    this.name = "DodoReadError";
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const malformed = () => new DodoReadError(false);

function providerId(value: unknown): string {
  if (typeof value === "string" && PROVIDER_ID.test(value)) return value;
  throw malformed();
}
const optionalId = (value: unknown) => (value == null ? undefined : providerId(value));
function safeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw malformed();
}
/** ISO date to epoch ms; undefined when absent or invalid. */
function epochMs(value: unknown): number | undefined {
  const ms = typeof value === "string" && ISO_DATE.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}
const optionalBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup: the body may already be locked or closed.
  }
}
const customerId = (body: Json) => providerId(isRecord(body.customer) ? body.customer.customer_id : undefined);

async function readJson(config: DodoReconcilerConfig, path: string, fetchImpl: typeof fetch): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DODO_READ_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE_URL[config.environment]}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
        // Never followed: a redirect is classified permanent below.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      // Network failure or timeout: transient by definition.
      throw new DodoReadError(true);
    }
    const { status } = response;
    if (!response.ok) {
      await discard(response);
      const redirected = response.type === "opaqueredirect" || (status >= 300 && status < 400);
      throw new DodoReadError(!redirected && !PERMANENT_STATUSES.has(status), status || undefined);
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBoundedBody(response, MAX_PROVIDER_BODY_BYTES);
    } catch {
      // The stream broke or the timeout fired mid-body.
      throw new DodoReadError(true, status);
    }
    if (!bytes) {
      await discard(response);
      throw new DodoReadError(false, status);
    }
    try {
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (isRecord(body)) return body;
    } catch {
      // Falls through to the permanent error below.
    }
    throw new DodoReadError(false, status);
  } finally {
    clearTimeout(timer);
  }
}

/** Unknown, not empty, when missing or malformed, so settlement stays pending. */
function servicePeriods(value: unknown): ProviderPayment["servicePeriods"] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return undefined;
  const periods: NonNullable<ProviderPayment["servicePeriods"]> = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const { subscription_id: id, proration_factor: factor } = item;
    const start = epochMs(item.starts_at);
    const end = epochMs(item.ends_at);
    if (typeof id !== "string" || !PROVIDER_ID.test(id) || start === undefined || end === undefined ||
      typeof factor !== "string" || !PRORATION_FACTOR.test(factor)) return undefined;
    periods.push({ subscriptionId: id, start, end, prorationFactor: factor });
  }
  return periods;
}

function cartLines(value: unknown): ProviderPayment["cart"] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw malformed();
  return value.map(item => {
    if (!isRecord(item)) throw malformed();
    return { productId: providerId(item.product_id), quantity: safeInteger(item.quantity) };
  });
}

export async function fetchPayment(
  config: DodoReconcilerConfig, paymentId: string, fetchImpl: typeof fetch = fetch,
): Promise<ProviderPayment> {
  providerId(paymentId);
  const body = await readJson(config, `/payments/${paymentId}`, fetchImpl);
  if (body.payment_id !== paymentId || body.business_id !== config.businessId) throw malformed();
  const createdAt = epochMs(body.created_at);
  if (createdAt === undefined) throw malformed();
  const { status, currency, charge_type: chargeType } = body;
  return {
    paymentId,
    businessId: config.businessId,
    customerId: customerId(body),
    status: typeof status === "string" && PAYMENT_STATUSES.has(status) ? status as ProviderPayment["status"] : "other",
    subscriptionId: optionalId(body.subscription_id),
    sessionId: optionalId(body.checkout_session_id),
    cart: cartLines(body.product_cart),
    totalMinor: safeInteger(body.total_amount),
    taxMinor: body.tax == null ? undefined : safeInteger(body.tax),
    currency: typeof currency === "string" && CURRENCY.test(currency) ? currency : "",
    createdAt,
    // Absent only when the provider sent none; anything unrecognisable stays visibly unknown.
    chargeType: chargeType == null ? undefined
      : typeof chargeType === "string" && CHARGE_TYPE.test(chargeType) ? chargeType : "other",
    servicePeriods: servicePeriods(body.service_periods),
    includesUsage: optionalBoolean(body.includes_usage),
    isUpdatePaymentMethod: optionalBoolean(body.is_update_payment_method),
  };
}

export async function fetchSubscription(
  config: DodoReconcilerConfig, subscriptionId: string, fetchImpl: typeof fetch = fetch,
): Promise<ProviderSubscription> {
  providerId(subscriptionId);
  const body = await readJson(config, `/subscriptions/${subscriptionId}`, fetchImpl);
  const { status, cancel_at_next_billing_date: cancelAtNextBillingDate } = body;
  if (body.subscription_id !== subscriptionId || typeof cancelAtNextBillingDate !== "boolean") throw malformed();
  return {
    subscriptionId,
    customerId: customerId(body),
    productId: providerId(body.product_id),
    quantity: body.quantity == null ? undefined : safeInteger(body.quantity),
    status: typeof status === "string" && SUBSCRIPTION_STATUSES.has(status)
      ? status as ProviderSubscription["status"] : "other",
    previousBillingAt: epochMs(body.previous_billing_date),
    nextBillingAt: epochMs(body.next_billing_date),
    cancelAtNextBillingDate,
  };
}
