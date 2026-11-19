import { v } from "convex/values";
import { Webhook } from "svix";

import { readBoundedBody } from "../src/features/billing/server/bounded-body";
import { internal } from "./_generated/api";
import { httpAction, internalQuery } from "./_generated/server";
import { LOG_PREFIX, readConvexBillingConfig } from "./billingEnv";
import { billingModeValidator } from "./schema";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
// Exact Dodo event types (SDK 2.63.0) that move money or access, each with the resource id its
// payload always carries. Every other authenticated type, even a new one in a known family, is ignored.
const FINANCIAL_EVENTS = new Map<string, "paymentId" | "subscriptionId">([
  ...["succeeded", "failed", "processing", "cancelled"].map(s => [`payment.${s}`, "paymentId"] as const),
  ...["active", "renewed", "on_hold", "paused", "unpaused", "past_due", "plan_changed", "updated",
    "update_payment_method", "cancelled", "failed", "expired"].map(s => [`subscription.${s}`, "subscriptionId"] as const),
  ...["succeeded", "failed"].map(s => [`refund.${s}`, "paymentId"] as const),
  ...["opened", "challenged", "accepted", "cancelled", "expired", "won", "lost"].map(s => [`dispute.${s}`, "paymentId"] as const),
]);
const EVENT_TYPE = /^[a-z_]{1,32}(\.[a-z_]{1,32}){1,3}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Strict header shapes also reject duplicated headers, which arrive comma-joined.
const SIGNED_HEADERS = {
  "webhook-id": /^[A-Za-z0-9_.:-]{1,128}$/,
  "webhook-timestamp": /^\d{1,12}$/,
  "webhook-signature": /^[a-z0-9]{1,8},[A-Za-z0-9+/=]{1,128}( [a-z0-9]{1,8},[A-Za-z0-9+/=]{1,128}){0,9}$/,
} as const;

type SignedHeaders = Record<keyof typeof SIGNED_HEADERS, string>;
type NormalizedEvent = {
  eventType: string; occurredAt: number; financial: boolean;
  customerId?: string; paymentId?: string; subscriptionId?: string; sessionId?: string;
};

const respond = (status: number, text?: string) => new Response(text ?? null, { status });

/** Mode, business and verifiers come only from this deployment's env; null fails closed. */
function readReceiver() {
  const config = readConvexBillingConfig("convex-receiver");
  if (!config) return null;
  try {
    const keys = [config.webhookKey, config.webhookKeyPrevious].filter((key): key is string => !!key);
    return { mode: config.environment, businessId: config.businessId, verifiers: keys.map(key => new Webhook(key)) };
  } catch (error) {
    // An undecodable or empty signing key is misconfiguration; the verifier's error never includes the key.
    console.error(`${LOG_PREFIX["convex-receiver"]} not configured:`, error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

function signedHeaders(headers: Headers): SignedHeaders | null {
  const picked = {} as SignedHeaders;
  for (const [name, pattern] of Object.entries(SIGNED_HEADERS) as [keyof SignedHeaders, RegExp][]) {
    const value = headers.get(name);
    if (value === null || !pattern.test(value)) return null;
    picked[name] = value;
  }
  return picked;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    // ignoreBOM keeps the exact signed text.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const verifies = (verifier: Webhook, body: string, headers: SignedHeaders) => {
  try {
    verifier.verify(body, headers);
    return true;
  } catch {
    return false;
  }
};

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps only bounded identifiers; null for any shape this receiver does not accept. */
function normalize(payload: unknown, businessId: string): NormalizedEvent | null {
  if (!isRecord(payload) || !isRecord(payload.data) || payload.business_id !== businessId) return null;
  const { type, timestamp, data } = payload;
  if (typeof type !== "string" || !EVENT_TYPE.test(type)) return null;
  const occurredAt = typeof timestamp === "string" && timestamp.length <= 64 ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(occurredAt)) return null;
  if (data.customer != null && !isRecord(data.customer)) return null;
  const ids = {
    customerId: isRecord(data.customer) ? data.customer.customer_id : undefined,
    paymentId: data.payment_id,
    subscriptionId: data.subscription_id,
    sessionId: data.checkout_session_id,
  };
  const requiredId = FINANCIAL_EVENTS.get(type);
  const event: NormalizedEvent = { eventType: type, occurredAt, financial: requiredId !== undefined };
  for (const [field, value] of Object.entries(ids) as [keyof typeof ids, unknown][]) {
    if (value == null) continue;
    if (typeof value !== "string" || !PROVIDER_ID.test(value)) return null;
    event[field] = value;
  }
  return requiredId && !event[requiredId] ? null : event;
}

export const customerRefByProviderId = internalQuery({
  args: { mode: billingModeValidator, customerId: v.string() },
  returns: v.union(v.id("billingCustomers"), v.null()),
  handler: async (ctx, { mode, customerId }) => {
    const customer = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_customerId", q => q.eq("mode", mode).eq("customerId", customerId)).unique();
    return customer?._id ?? null;
  },
});

/**
 * Dodo Standard Webhooks receiver. Verifies before any parse or write, then durably
 * records a minimal receipt. 2xx means recorded, never fulfilled.
 */
export const receiveDodoWebhook = httpAction(async (ctx, request) => {
  const receiver = readReceiver();
  if (!receiver) {
    // Non-2xx so Dodo retries once the deployment is configured.
    return respond(503, "Webhook not configured");
  }
  const bytes = await readBoundedBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (!bytes) return respond(413, "Payload too large");
  const headers = signedHeaders(request.headers);
  const body = decodeUtf8(bytes);
  if (!headers || body === null || !receiver.verifiers.some(verifier => verifies(verifier, body, headers))) {
    return respond(400, "Invalid signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return respond(400, "Invalid payload");
  }
  const event = normalize(payload, receiver.businessId);
  if (!event) {
    const type = isRecord(payload) && typeof payload.type === "string" && EVENT_TYPE.test(payload.type) ? payload.type : "unknown";
    console.error("[billingWebhook] rejected a verified delivery with an invalid payload:", type);
    return respond(400, "Invalid payload");
  }

  const { financial, customerId, ...fields } = event;
  const customerRef = customerId === undefined ? null
    : await ctx.runQuery(internal.billingWebhook.customerRefByProviderId, { mode: receiver.mode, customerId });
  await ctx.runMutation(internal.billing.recordReceipt, {
    ...fields,
    mode: receiver.mode,
    webhookId: headers["webhook-id"],
    bodyDigest: await sha256Hex(bytes),
    // An unmapped receipt keeps its provider customer id so binding that customer later attaches it.
    ...(customerRef ? { customerRef } : customerId !== undefined ? { providerCustomerId: customerId } : {}),
    ...(financial ? {} : { ignored: true }),
  });
  return respond(200);
});
