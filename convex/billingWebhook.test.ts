// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import { MAX_WEBHOOK_BODY_BYTES } from "./billingWebhook";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const setup = () => convexTest(schema, modules);
type TestBackend = ReturnType<typeof setup>;

// Throwaway synthetic secrets; real keys live only in deployment env.
const newKey = () => `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))}`;
const KEY = newKey();
const PREVIOUS_KEY = newKey();
const BUSINESS = "bus_synthetic";
const PATH = "/billing/webhook";
const receiverEnv = {
  CODENAYA_DEPLOYMENT: "development",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PAYMENTS_BUSINESS_ID: BUSINESS,
  DODO_PAYMENTS_WEBHOOK_KEY: KEY,
};

// Dodo SDK 2.63.0 financial events and the payload id each one must carry.
const FINANCIAL_EVENTS: [string, string][] = [
  ...["succeeded", "failed", "processing", "cancelled"].map(s => [`payment.${s}`, "payment_id"]),
  ...["active", "renewed", "on_hold", "paused", "unpaused", "past_due", "plan_changed", "updated",
    "update_payment_method", "cancelled", "failed", "expired"].map(s => [`subscription.${s}`, "subscription_id"]),
  ...["succeeded", "failed"].map(s => [`refund.${s}`, "payment_id"]),
  ...["opened", "challenged", "accepted", "cancelled", "expired", "won", "lost"].map(s => [`dispute.${s}`, "payment_id"]),
] as [string, string][];

const event = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  business_id: BUSINESS,
  type: "payment.succeeded",
  timestamp: "2026-11-17T00:00:00.000Z",
  data: {
    payload_type: "Payment",
    payment_id: "pay_synthetic",
    subscription_id: null,
    customer: { customer_id: "cus_user_alice", email: "alice@example.com", name: "Alice" },
    ...data,
  },
  ...overrides,
});

function signed(payload: unknown, options: { key?: string; body?: string; id?: string; skewSeconds?: number } = {}) {
  const body = options.body ?? JSON.stringify(payload);
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const at = new Date(Date.now() + (options.skewSeconds ?? 0) * 1000);
  return {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
      "webhook-signature": new Webhook(options.key ?? KEY).sign(id, at, body),
    } as Record<string, string>,
    body,
  };
}

async function mappedCustomer(t: TestBackend) {
  await t.run(ctx => ctx.db.insert("users", { clerkUserId: "user_alice", updatedAt: 1 }));
  const customerRef = await t.mutation(internal.billing.ensureCustomer, {
    mode: "test_mode", userId: "user_alice", ownerTokenIdentifier: "https://clerk.synthetic|user_alice",
  });
  await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: "cus_user_alice" });
  return customerRef;
}

const receipts = (t: TestBackend) => t.run(ctx => ctx.db.query("billingEvents").take(10));
const counters = (t: TestBackend) => t.run(async ctx => {
  const customer = await ctx.db.query("billingCustomers").first();
  return { inputRevision: customer?.inputRevision, unresolvedReceipts: customer?.unresolvedReceipts };
});

/** Asserts the status and that nothing at all was written. */
async function expectRejected(t: TestBackend, init: RequestInit, status = 400) {
  const before = [await receipts(t), await counters(t)];
  expect((await t.fetch(PATH, init)).status).toBe(status);
  expect([await receipts(t), await counters(t)]).toEqual(before);
}

async function sha256Hex(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("POST /billing/webhook", () => {
  beforeEach(() => {
    // Mapped receipts schedule processing; fake timers keep those runs from firing after the test.
    vi.useFakeTimers();
    // The receiver must work even where the runtime defines `window` (the guard is Next-only).
    vi.stubGlobal("window", {});
    for (const [name, value] of Object.entries(receiverEnv)) vi.stubEnv(name, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("stores a mapped financial event as a pending minimal receipt", async () => {
    const t = setup();
    const customerRef = await mappedCustomer(t);
    const request = signed(event({}, { subscription_id: "sub_synthetic", checkout_session_id: "cks_synthetic" }));

    expect((await t.fetch(PATH, request)).status).toBe(200);
    const [row] = await receipts(t);
    expect(row).toMatchObject({
      customerRef, mode: "test_mode", state: "pending", webhookId: request.headers["webhook-id"],
      eventType: "payment.succeeded", occurredAt: Date.parse("2026-11-17T00:00:00.000Z"),
      paymentId: "pay_synthetic", subscriptionId: "sub_synthetic", sessionId: "cks_synthetic",
      bodyDigest: await sha256Hex(request.body),
    });
    expect(JSON.stringify(row)).not.toMatch(/alice@example\.com|Alice"|cus_user_alice|v1,/);
    expect(await counters(t)).toEqual({ inputRevision: 1, unresolvedReceipts: 1 });
  });

  test("quarantines an unmapped financial event instead of discarding it", async () => {
    const t = setup();
    expect((await t.fetch(PATH, signed(event({ type: "refund.succeeded" })))).status).toBe(200);
    const [row] = await receipts(t);
    expect(row).toMatchObject({ state: "quarantined", eventType: "refund.succeeded", paymentId: "pay_synthetic" });
    expect(row.customerRef).toBeUndefined();
  });

  test("a duplicate delivery returns 200 and keeps one receipt", async () => {
    const t = setup();
    await mappedCustomer(t);
    const request = signed(event());
    expect((await t.fetch(PATH, request)).status).toBe(200);
    expect((await t.fetch(PATH, request)).status).toBe(200);
    expect(await receipts(t)).toHaveLength(1);
    expect(await counters(t)).toEqual({ inputRevision: 1, unresolvedReceipts: 1 });
  });

  test.each(["credit.added", "payment.foo", "subscription.trial_ended", "refund.pending", "dispute.reopened"])(
    "records unsupported authenticated %s as ignored without dirtying the customer",
    async type => {
      const t = setup();
      await mappedCustomer(t);
      expect((await t.fetch(PATH, signed(event({ type })))).status).toBe(200);
      expect(await receipts(t)).toMatchObject([{ state: "ignored", eventType: type }]);
      expect(await counters(t)).toEqual({ inputRevision: 0, unresolvedReceipts: 0 });
    },
  );

  test("records an unsupported event from an unmapped customer as ignored, not quarantined", async () => {
    const t = setup();
    await mappedCustomer(t);
    const request = signed(event({ type: "payment.foo" }, { customer: { customer_id: "cus_unmapped" } }));
    expect((await t.fetch(PATH, request)).status).toBe(200);
    const [row] = await receipts(t);
    expect(row).toMatchObject({ state: "ignored", eventType: "payment.foo" });
    expect(row.customerRef).toBeUndefined();
    expect(await counters(t)).toEqual({ inputRevision: 0, unresolvedReceipts: 0 });
  });

  test.each(FINANCIAL_EVENTS)("%s requires %s before any write", async (type, idField) => {
    const t = setup();
    await mappedCustomer(t);
    const ids = { payment_id: "pay_synthetic", subscription_id: "sub_synthetic" };
    for (const missing of [undefined, null, ""]) {
      await expectRejected(t, signed(event({ type }, { ...ids, [idField]: missing })));
    }
    expect((await t.fetch(PATH, signed(event({ type }, ids)))).status).toBe(200);
    expect(await receipts(t)).toMatchObject([{ state: "pending", eventType: type }]);
    expect(await counters(t)).toEqual({ inputRevision: 1, unresolvedReceipts: 1 });
  });

  test("accepts the previous key only while it is configured", async () => {
    const t = setup();
    await expectRejected(t, signed(event(), { key: PREVIOUS_KEY }));
    vi.stubEnv("DODO_PAYMENTS_WEBHOOK_KEY_PREVIOUS", PREVIOUS_KEY);
    expect((await t.fetch(PATH, signed(event(), { key: PREVIOUS_KEY }))).status).toBe(200);
    expect((await t.fetch(PATH, signed(event()))).status).toBe(200);
    expect(await receipts(t)).toHaveLength(2);
  });

  test("rejects a wrong key, stale or far-future timestamps and tampered bytes", async () => {
    const t = setup();
    await mappedCustomer(t);
    await expectRejected(t, signed(event(), { key: newKey() }));
    await expectRejected(t, signed(event(), { skewSeconds: -6 * 60 }));
    await expectRejected(t, signed(event(), { skewSeconds: 6 * 60 }));
    const tampered = signed(event());
    tampered.body = tampered.body.replace("pay_synthetic", "pay_attacker1");
    await expectRejected(t, tampered);
    const padded = signed(event());
    padded.body = ` ${padded.body}`;
    await expectRejected(t, padded);
  });

  test("rejects missing, malformed and duplicated signature headers", async () => {
    const t = setup();
    await mappedCustomer(t);
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const request = signed(event());
      delete request.headers[name];
      await expectRejected(t, request);
    }
    const malformed = signed(event());
    malformed.headers["webhook-timestamp"] = `${malformed.headers["webhook-timestamp"]}abc`;
    await expectRejected(t, malformed);
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const request = signed(event());
      const headers = new Headers(request.headers);
      headers.append(name, name === "webhook-signature" ? signed(event()).headers[name] : request.headers[name]);
      await expectRejected(t, { ...request, headers });
    }
    // Svix-named headers are never consulted.
    const svixNamed = signed(event());
    const headers = Object.fromEntries(Object.entries(svixNamed.headers).map(([name, value]) => [name.replace("webhook", "svix"), value]));
    await expectRejected(t, { ...svixNamed, headers });
  });

  test("rejects signed invalid JSON, invalid shapes and another business", async () => {
    const t = setup();
    await mappedCustomer(t);
    await expectRejected(t, signed(null, { body: "{not json" }));
    await expectRejected(t, signed(event({ business_id: "bus_other" })));
    await expectRejected(t, signed(event({ business_id: undefined })));
    await expectRejected(t, signed(event({ type: "Payment Succeeded" })));
    await expectRejected(t, signed(event({ timestamp: "yesterday" })));
    await expectRejected(t, signed(event({ data: [] })));
    await expectRejected(t, signed(event({}, { payment_id: 42 })));
    await expectRejected(t, signed(event({}, { customer: "cus_user_alice" })));
    await expectRejected(t, signed(event({}, { payment_id: "x".repeat(129) })));
  });

  test("rejects an oversize body before verifying it", async () => {
    const t = setup();
    await mappedCustomer(t);
    const padding = "x".repeat(MAX_WEBHOOK_BODY_BYTES);
    await expectRejected(t, signed(event({}, { padding })), 413);
  });

  test.each([
    ["absent deployment", { CODENAYA_DEPLOYMENT: undefined }],
    ["invalid deployment", { CODENAYA_DEPLOYMENT: "prod" }],
    ["placeholder deployment", { CODENAYA_DEPLOYMENT: "PLACEHOLDER_DEPLOYMENT" }],
    ["production with test mode", { CODENAYA_DEPLOYMENT: "production" }],
    ["development with live mode", { DODO_PAYMENTS_ENVIRONMENT: "live_mode" }],
    ["absent webhook key", { DODO_PAYMENTS_WEBHOOK_KEY: undefined }],
    ["placeholder webhook key", { DODO_PAYMENTS_WEBHOOK_KEY: "PLACEHOLDER_WEBHOOK_KEY" }],
    ["absent business", { DODO_PAYMENTS_BUSINESS_ID: undefined }],
  ])("fails closed with 503 for %s", async (_, overrides: Record<string, string | undefined>) => {
    const t = setup();
    await mappedCustomer(t);
    for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expectRejected(t, signed(event()), 503);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toMatch(/^\[billingWebhook\] receiver not configured/);
    expect(logged).not.toContain(KEY);
  });
});
