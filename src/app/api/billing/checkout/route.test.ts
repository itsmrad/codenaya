import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  getToken: vi.fn(),
  convex: {} as Record<string, Mock<(args: unknown) => Promise<unknown>>>,
  fetchMutation: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs/server")>()),
  auth: mocks.auth,
  currentUser: mocks.currentUser,
}));
vi.mock("convex/nextjs", () => ({ fetchMutation: mocks.fetchMutation }));

import { CHECKOUT_HOSTS } from "@/features/billing/checkout-url";
import { resetRateLimits } from "@/lib/rate-limit";

import { POST } from "./route";

const ORIGIN = "http://localhost:3100";
const KEY = "synthetic-next-key";
const EMAIL = "alice@example.test";
const CHECKOUT_URL = `https://${CHECKOUT_HOSTS.test_mode}/session/cks_1`;
const ENV = {
  CODENAYA_BILLING_ENABLED: "true",
  CODENAYA_DEPLOYMENT: "development",
  CODENAYA_BILLING_TOP_UPS_ENABLED: "true",
  CREDIT_LIMITS_ENFORCED: "true",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PAYMENTS_BUSINESS_ID: "bus_1",
  DODO_PAYMENTS_API_KEY: KEY,
  DODO_PAYMENTS_PRO_PRODUCT_ID: "prod_pro",
  DODO_PAYMENTS_TOP_UP_PRODUCT_ID: "prod_top_up",
  NEXT_PUBLIC_APP_URL: ORIGIN,
  DODO_PAYMENTS_RETURN_URL: `${ORIGIN}/settings/billing/return`,
  CODENAYA_CONVEX_INTERNAL_KEY: "internal",
};

const post = (body: unknown = { sku: "pro_monthly" }, headers: Record<string, string> = {}) =>
  POST(new Request(`${ORIGIN}/api/billing/checkout`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const customerCreated = () => json({ customer_id: "cus_1", business_id: "bus_1", email: EMAIL, name: "Alice" });
const checkoutCreated = (url: string = CHECKOUT_URL) => json({ session_id: "cks_1", checkout_url: url });
const createCustomer = { kind: "create_customer", customerRef: "cust_ref", leaseId: "lease_1" };
const createCheckout = { kind: "create_checkout", purchaseRef: "purchase_ref", intentId: "intent_1", customerId: "cus_1" };

/** The Convex calls by function name, in order. */
const convexCalls = () =>
  mocks.fetchMutation.mock.calls.map(([ref, args, options]) => ({ name: getFunctionName(ref), args, options }));
const recorded = (name: string) => convexCalls().filter(call => call.name === `billingCheckout:${name}`).map(call => call.args);
const sentToDodo = (index: number) => JSON.parse(mocks.fetch.mock.calls[index][1]?.body as string) as Record<string, unknown>;

describe("POST /api/billing/checkout", () => {
  let logs: unknown[][];

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.auth.mockResolvedValue({ userId: "user_alice", getToken: mocks.getToken });
    mocks.getToken.mockResolvedValue("jwt");
    mocks.currentUser.mockResolvedValue({ primaryEmailAddress: { emailAddress: EMAIL }, fullName: "Alice A", username: null });
    mocks.convex = {
      "billingCheckout:prepareCheckout": vi.fn().mockResolvedValue(createCheckout),
      "billingCheckout:recordCustomerResult": vi.fn().mockResolvedValue(null),
      "billingCheckout:recordCheckoutResult": vi.fn().mockResolvedValue(null),
    };
    mocks.fetchMutation.mockImplementation((ref, args) => mocks.convex[getFunctionName(ref)](args));
    logs = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const expectNoSecretsLogged = () => {
    const text = JSON.stringify(logs);
    for (const secret of [KEY, EMAIL, "Alice", CHECKOUT_URL, "jwt", "internal"]) expect(text).not.toContain(secret);
  };

  describe("guards", () => {
    it("401s when signed out", async () => {
      mocks.auth.mockResolvedValue({ userId: null, getToken: mocks.getToken });
      const res = await post();
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("403s a foreign Origin and 415s a non-JSON body", async () => {
      const foreign = await post(undefined, { origin: "https://evil.test" });
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ code: "cross_origin" });
      expect((await post(undefined, { "content-type": "text/plain" })).status).toBe(415);
      expect(mocks.fetchMutation).not.toHaveBeenCalled();
    });

    it("429s past the per-user limit", async () => {
      mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue({ kind: "pending" });
      for (let i = 0; i < 5; i++) expect((await post()).status).toBe(409);
      const res = await post();
      expect(res.status).toBe(429);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it.each([[{ sku: "pro_monthly", productId: "prod_evil" }], [{ sku: "enterprise" }], [{}], ["not json"]])(
      "400s %j", async body => {
        expect((await post(body)).status).toBe(400);
        expect(mocks.fetchMutation).not.toHaveBeenCalled();
      });

    it("404s while billing is disabled, even without a deployment", async () => {
      vi.stubEnv("CODENAYA_BILLING_ENABLED", "");
      vi.stubEnv("CODENAYA_DEPLOYMENT", "");
      const res = await post();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    });

    it("404s a top-up while top-ups are disabled", async () => {
      vi.stubEnv("CODENAYA_BILLING_TOP_UPS_ENABLED", "");
      expect((await post({ sku: "top_up" })).status).toBe(404);
      expect(mocks.fetchMutation).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing deployment", { CODENAYA_DEPLOYMENT: "" }],
      ["an unknown deployment", { CODENAYA_DEPLOYMENT: "prod" }],
      ["live mode outside production", { DODO_PAYMENTS_ENVIRONMENT: "live_mode" }],
      ["a missing API key", { DODO_PAYMENTS_API_KEY: "" }],
    ])("503s %s without config text", async (_label, env) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const res = await post();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Billing is unavailable", code: "billing_unavailable" });
      expect(mocks.fetchMutation).not.toHaveBeenCalled();
      expectNoSecretsLogged();
    });

    it("logs which variable is missing, never a value", async () => {
      vi.stubEnv("DODO_PAYMENTS_API_KEY", "");
      expect((await post()).status).toBe(503);
      expect(JSON.stringify(logs)).toContain("DODO_PAYMENTS_API_KEY");
      expect(JSON.stringify(logs)).not.toContain("bus_1");
    });

    it("answers 500 with no-store and no internal text when something unexpected throws", async () => {
      mocks.auth.mockRejectedValue(new Error("clerk exploded: secret detail"));
      const res = await post();
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Checkout could not be started" });
      expect(JSON.stringify(logs)).not.toContain("secret detail");
    });
  });

  it("creates the customer, then the checkout, and answers the hosted URL", async () => {
    mocks.convex["billingCheckout:prepareCheckout"]
      .mockResolvedValueOnce(createCustomer).mockResolvedValueOnce(createCheckout);
    mocks.fetch.mockResolvedValueOnce(customerCreated()).mockResolvedValueOnce(checkoutCreated());

    const res = await post({ sku: "pro_monthly" }, { host: "evil.test", "x-forwarded-host": "evil.test" });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ url: CHECKOUT_URL });
    expect(convexCalls().every(call => call.options?.token === "jwt")).toBe(true);
    expect(recorded("prepareCheckout")).toEqual([
      { internalKey: "internal", mode: "test_mode", sku: "pro_monthly", productId: "prod_pro" },
      { internalKey: "internal", mode: "test_mode", sku: "pro_monthly", productId: "prod_pro" },
    ]);
    expect(sentToDodo(0)).toEqual({ email: EMAIL, name: "Alice A" });
    expect(recorded("recordCustomerResult")).toEqual([
      { internalKey: "internal", customerRef: "cust_ref", leaseId: "lease_1", result: { kind: "created", customerId: "cus_1" } },
    ]);
    // Server-chosen product, quantity, customer, metadata and return URL, whatever Host the request names.
    expect(sentToDodo(1)).toEqual({
      product_cart: [{ product_id: "prod_pro", quantity: 1 }],
      customer: { customer_id: "cus_1" },
      return_url: `${ORIGIN}/settings/billing/return`,
      metadata: { purchaseId: "intent_1", purpose: "pro_monthly" },
      feature_flags: { allow_discount_code: false },
    });
    expect(recorded("recordCheckoutResult")).toEqual([{
      internalKey: "internal", purchaseRef: "purchase_ref",
      result: { kind: "created", sessionId: "cks_1", checkoutUrl: CHECKOUT_URL },
    }]);
    expectNoSecretsLogged();
  });

  it("uses the top-up product for a top-up", async () => {
    mocks.fetch.mockResolvedValueOnce(checkoutCreated());
    expect((await post({ sku: "top_up" })).status).toBe(200);
    expect(recorded("prepareCheckout")[0]).toMatchObject({ sku: "top_up", productId: "prod_top_up" });
    expect(sentToDodo(0)).toMatchObject({
      product_cart: [{ product_id: "prod_top_up", quantity: 1 }], metadata: { purchaseId: "intent_1", purpose: "top_up" },
    });
  });

  it("resumes an open session without calling Dodo", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue({ kind: "resume", checkoutUrl: CHECKOUT_URL });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: CHECKOUT_URL });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "pending" }, 409, "checkout_pending"],
    [{ kind: "refused", code: "already_subscribed" }, 409, "already_subscribed"],
    [{ kind: "refused", code: "not_pro" }, 409, "not_pro"],
    [{ kind: "refused", code: "top_up_cap" }, 409, "top_up_cap"],
    [{ kind: "refused", code: "support_required" }, 409, "support_required"],
    [{ kind: "refused", code: "unavailable" }, 503, "billing_unavailable"],
  ])("answers %j with %i %s", async (decision, status, code) => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(decision);
    const res = await post();
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("403s a held or deleted owner", async () => {
    mocks.convex["billingCheckout:prepareCheckout"]
      .mockRejectedValue(new ConvexError({ code: "FORBIDDEN", message: "Billing owner is unavailable" }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "billing_on_hold" });
  });

  it("401s when Convex rejects the caller's token or key", async () => {
    mocks.convex["billingCheckout:prepareCheckout"]
      .mockRejectedValue(new ConvexError({ code: "UNAUTHENTICATED", message: "Not signed in" }));
    expect((await post()).status).toBe(401);
  });

  it("releases the lease when the Clerk user read fails, without calling Dodo", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(createCustomer);
    mocks.currentUser.mockRejectedValue(new Error("clerk 429"));
    const res = await post();
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "checkout_unavailable" });
    expect(recorded("recordCustomerResult")).toEqual([
      { internalKey: "internal", customerRef: "cust_ref", leaseId: "lease_1", result: { kind: "not_created" } },
    ]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("still answers 502 when releasing the lease after a Clerk failure also fails", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(createCustomer);
    mocks.convex["billingCheckout:recordCustomerResult"].mockRejectedValue(new Error("convex down"));
    mocks.currentUser.mockRejectedValue(new Error("clerk 429"));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "checkout_unavailable" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("releases the lease and asks for an email when the user has none, without calling Dodo", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(createCustomer);
    mocks.currentUser.mockResolvedValue({ primaryEmailAddress: null, fullName: "Alice A" });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "email_required" });
    expect(recorded("recordCustomerResult")).toEqual([
      { internalKey: "internal", customerRef: "cust_ref", leaseId: "lease_1", result: { kind: "not_created" } },
    ]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("records a lost customer create as unknown and stops", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(createCustomer);
    mocks.fetch.mockResolvedValue(json({}, 500));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "checkout_unavailable" });
    expect(recorded("recordCustomerResult")[0]).toMatchObject({ result: { kind: "unknown" } });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(recorded("prepareCheckout")).toHaveLength(1);
  });

  it.each([
    ["a timeout", () => Promise.reject(new DOMException("aborted", "AbortError")), "unknown", "checkout_unknown"],
    ["a 5xx", () => Promise.resolve(json({}, 502)), "unknown", "checkout_unknown"],
    ["a 422", () => Promise.resolve(json({ message: "bad" }, 422)), "not_created", "checkout_failed"],
  ])("records %s on the checkout create once, never retried", async (_label, respond, kind, code) => {
    mocks.fetch.mockImplementation(respond);
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(recorded("recordCheckoutResult")).toEqual([{ internalKey: "internal", purchaseRef: "purchase_ref", result: { kind } }]);
  });

  it("withholds a checkout URL on a foreign host but records the session", async () => {
    mocks.fetch.mockResolvedValue(checkoutCreated("https://evil.test/pay"));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "checkout_unavailable" });
    expect(recorded("recordCheckoutResult")[0]).toMatchObject({ result: { kind: "created", sessionId: "cks_1" } });
    expect(JSON.stringify(recorded("recordCheckoutResult"))).not.toContain("evil.test");
    // Only the host is logged, so a mismatch is diagnosable without leaking the session link.
    expect(JSON.stringify(logs)).toContain("evil.test");
    expect(JSON.stringify(logs)).not.toContain("/pay");
  });

  it("answers checkout_unknown when recording a created session fails, without a second create", async () => {
    mocks.fetch.mockResolvedValue(checkoutCreated());
    mocks.convex["billingCheckout:recordCheckoutResult"].mockRejectedValue(new Error("convex down"));
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ code: "checkout_unknown" });
    expect(JSON.stringify(body)).not.toContain(CHECKOUT_URL);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(recorded("prepareCheckout")).toHaveLength(1);
    expectNoSecretsLogged();
  });

  it("answers checkout_unknown when recording a created customer fails, without a checkout create", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(createCustomer);
    mocks.convex["billingCheckout:recordCustomerResult"].mockRejectedValue(new Error("convex down"));
    mocks.fetch.mockResolvedValue(customerCreated());
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "checkout_unknown" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expectNoSecretsLogged();
  });

  it("never loops past two Convex decisions", async () => {
    mocks.convex["billingCheckout:prepareCheckout"].mockResolvedValue(createCustomer);
    mocks.fetch.mockImplementation(async () => customerCreated());
    const res = await post();
    expect(res.status).toBe(502);
    expect(recorded("prepareCheckout")).toHaveLength(2);
  });
});
