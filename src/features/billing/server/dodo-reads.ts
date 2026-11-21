// Server-only Dodo reads for reconciliation. Errors carry a fixed message and the HTTP status
// only: never the key, URL or body. Field names follow the dodopayments SDK 2.63.0 types.
import {
  MAX_ADJUSTMENTS_PER_PAYMENT, type ProviderDispute, type ProviderRefund,
} from "../reversals";
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
const REFUND_STATUSES = new Set(["succeeded", "failed", "pending", "review"]);
const DISPUTE_STATUSES = new Set(["opened", "challenged", "won", "lost", "accepted", "cancelled", "expired"]);
const MINOR_AMOUNT = /^\d{1,15}$/;
const MAJOR_AMOUNT = /^(\d{1,12})(?:\.(\d{1,3}))?$/;
// ISO 4217 minor-unit exponents other than 2.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const MALFORMED_DISCOUNT = "malformed";

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
const currencyCode = (value: unknown) => (typeof value === "string" && CURRENCY.test(value) ? value : "");

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

// SDK 2.63.0 deprecates `discount_id` for `discounts`; either one marks the payment discounted. An
// unreadable discount is still a discount: it quarantines the grant without failing the whole read,
// so the payment's refunds and disputes are still processed.
function discountId(body: Json): string | undefined {
  const { discount_id: legacy, discounts } = body;
  if (legacy == null && (discounts == null || (Array.isArray(discounts) && discounts.length === 0))) return undefined;
  const first: unknown = Array.isArray(discounts) ? discounts[0] : undefined;
  const id = legacy ?? (isRecord(first) ? first.discount_id : undefined);
  return typeof id === "string" && PROVIDER_ID.test(id) ? id : MALFORMED_DISCOUNT;
}

function refund(item: Json): ProviderRefund | undefined {
  const { refund_id: id, status, amount, is_partial: isPartial } = item;
  const amountOk = amount == null || (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0);
  if (typeof id !== "string" || !PROVIDER_ID.test(id) || !amountOk || typeof isPartial !== "boolean") return undefined;
  return {
    refundId: id,
    status: typeof status === "string" && REFUND_STATUSES.has(status) ? status as ProviderRefund["status"] : "other",
    amountMinor: amount ?? null, currency: currencyCode(item.currency), isPartial,
  };
}

type PaymentRef = { paymentId: string; businessId: string; totalMinor: number; currency: string };

/**
 * SDK 2.63.0 documents `Dispute.amount` only as a string, with no unit. It is counted only when it
 * unambiguously equals the payment's gross total, as minor units ("2000") or as major units in the
 * payment's currency ("20" or "20.00" for USD 2000): a full dispute. Anything else is unknown, so the
 * reversal stays unknown until an operator resolves it, never a guessed partial amount.
 */
function disputeAmount(value: unknown, payment: PaymentRef): number | null {
  const { totalMinor, currency } = payment;
  if (typeof value !== "string" || currency === "") return null;
  if (MINOR_AMOUNT.test(value) && Number(value) === totalMinor) return totalMinor;
  const major = MAJOR_AMOUNT.exec(value);
  const digits = ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;
  const fraction = major?.[2] ?? "";
  if (!major || fraction.length > digits) return null;
  const minor = Number(major[1]) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  return minor === totalMinor ? totalMinor : null;
}

/** SDK `DisputeStatus` without its `dispute_` prefix; anything else is "other". Shared by the payment and list reads. */
function disputeStatus(value: unknown): ProviderDispute["status"] {
  const bare = typeof value === "string" && value.startsWith("dispute_") ? value.slice("dispute_".length) : "";
  return DISPUTE_STATUSES.has(bare) ? bare as ProviderDispute["status"] : "other";
}

function dispute(item: Json, payment: PaymentRef): ProviderDispute | undefined {
  const { dispute_id: id, dispute_status: status, amount } = item;
  if (typeof id !== "string" || !PROVIDER_ID.test(id)) return undefined;
  return {
    disputeId: id,
    status: disputeStatus(status),
    amountMinor: disputeAmount(amount, payment),
    currency: currencyCode(item.currency),
  };
}

/**
 * The payment's whole current refund and dispute lists; unknown (undefined), never empty, when
 * missing, oversize or malformed. An entry of another payment or business fails the whole read.
 */
function adjustments(body: Json, payment: PaymentRef): ProviderPayment["adjustments"] {
  const { paymentId, businessId } = payment;
  function list<T>(value: unknown, normalize: (item: Json) => T | undefined): T[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_ADJUSTMENTS_PER_PAYMENT) return undefined;
    const items: T[] = [];
    for (const item of value) {
      if (isRecord(item) && (item.payment_id !== paymentId || item.business_id !== businessId)) throw malformed();
      const normalized = isRecord(item) ? normalize(item) : undefined;
      if (normalized !== undefined) items.push(normalized);
    }
    // Every entry's owner is checked before a malformed one makes the list unknown.
    return items.length === value.length ? items : undefined;
  }
  const refunds = list(body.refunds, refund);
  const disputes = list(body.disputes, item => dispute(item, payment));
  return refunds && disputes ? { refunds, disputes } : undefined;
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
  const { status, charge_type: chargeType } = body;
  const totalMinor = safeInteger(body.total_amount);
  const currency = currencyCode(body.currency);
  return {
    paymentId,
    businessId: config.businessId,
    customerId: customerId(body),
    status: typeof status === "string" && PAYMENT_STATUSES.has(status) ? status as ProviderPayment["status"] : "other",
    subscriptionId: optionalId(body.subscription_id),
    sessionId: optionalId(body.checkout_session_id),
    cart: cartLines(body.product_cart),
    totalMinor,
    taxMinor: body.tax == null ? undefined : safeInteger(body.tax),
    currency,
    createdAt,
    // Absent only when the provider sent none; anything unrecognisable stays visibly unknown.
    chargeType: chargeType == null ? undefined
      : typeof chargeType === "string" && CHARGE_TYPE.test(chargeType) ? chargeType : "other",
    servicePeriods: servicePeriods(body.service_periods),
    includesUsage: optionalBoolean(body.includes_usage),
    isUpdatePaymentMethod: optionalBoolean(body.is_update_payment_method),
    discountId: discountId(body),
    adjustments: adjustments(body, { paymentId, businessId: config.businessId, totalMinor, currency }),
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

/** One listed resource: id, raw status (bounded, else "other"), creation time and the payment a refund or dispute names. */
export type ListedResource = { id: string; status: string; createdAt: number; paymentId?: string };
export type ListKind = "payments" | "refunds" | "disputes" | "subscriptions";
const LIST_FIELDS: Record<ListKind, { id: string; status: string }> = {
  payments: { id: "payment_id", status: "status" },
  refunds: { id: "refund_id", status: "status" },
  disputes: { id: "dispute_id", status: "dispute_status" },
  subscriptions: { id: "subscription_id", status: "status" },
};
const LISTED_STATUS = /^[a-z_]{1,40}$/;

/** A fixed creation-time window and a 0-based page (the API's default page is 0; paging is by offset). */
export type ListWindow = { since: number; until: number; page: number };

/**
 * One page (at most 20) of a customer's resources created within the window. The window is fixed
 * across pages, so offsets stay stable as long as the provider orders by an immutable key such as
 * creation time (assumed; undocumented); `full` means the next page may hold more. Dispute statuses
 * are normalized exactly as on a payment read.
 */
export async function listCustomerResources(
  config: DodoReconcilerConfig, kind: ListKind, providerCustomerId: string, window: ListWindow, fetchImpl: typeof fetch = fetch,
): Promise<{ items: ListedResource[]; full: boolean }> {
  if (!Number.isSafeInteger(window.page) || window.page < 0) throw malformed();
  const query = new URLSearchParams({
    customer_id: providerId(providerCustomerId), created_at_gte: new Date(window.since).toISOString(),
    created_at_lte: new Date(window.until).toISOString(), page_size: String(MAX_LIST_ITEMS), page_number: String(window.page),
  });
  const { items } = await readJson(config, `/${kind}?${query}`, fetchImpl);
  if (!Array.isArray(items) || items.length > MAX_LIST_ITEMS) throw malformed();
  const fields = LIST_FIELDS[kind];
  const listed = items.map((item): ListedResource => {
    if (!isRecord(item)) throw malformed();
    // A listed payment or subscription of another customer means the filter was not applied: fail closed.
    if ((kind === "payments" || kind === "subscriptions") && providerCustomerId !== customerId(item)) throw malformed();
    const createdAt = epochMs(item.created_at);
    if (createdAt === undefined) throw malformed();
    const status = item[fields.status];
    return {
      id: providerId(item[fields.id]), createdAt,
      status: kind === "disputes" ? disputeStatus(status) : typeof status === "string" && LISTED_STATUS.test(status) ? status : "other",
      ...(kind === "refunds" || kind === "disputes" ? { paymentId: providerId(item.payment_id) } : {}),
    };
  });
  return { items: listed, full: listed.length === MAX_LIST_ITEMS };
}

/** `GET /checkouts/{id}` (SDK `CheckoutSessionStatus`): creation time and the payment, if one was attempted. No expiry exists. */
export async function fetchCheckoutSession(
  config: DodoReconcilerConfig, sessionId: string, fetchImpl: typeof fetch = fetch,
): Promise<{ createdAt: number; paymentId?: string; paymentStatus?: string }> {
  providerId(sessionId);
  const body = await readJson(config, `/checkouts/${sessionId}`, fetchImpl);
  const createdAt = epochMs(body.created_at);
  if (body.id !== sessionId || createdAt === undefined) throw malformed();
  const status = body.payment_status;
  return {
    createdAt,
    ...(body.payment_id == null ? {} : { paymentId: providerId(body.payment_id) }),
    ...(status == null ? {} : { paymentStatus: typeof status === "string" && LISTED_STATUS.test(status) ? status : "other" }),
  };
}
