import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { POST as cancel } from "@/app/api/billing/cancel/route";
import { POST as uncancel } from "@/app/api/billing/uncancel/route";
const mocks = vi.hoisted(() => ({ user: vi.fn(), auth: vi.fn(), mutation: vi.fn(), provider: vi.fn(), limit: vi.fn() }));
vi.mock("@/features/auth/server/require-user-id", () => ({ requireUserId: mocks.user }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("convex/nextjs", () => ({ fetchMutation: mocks.mutation }));
vi.mock("./dodo-subscription", () => ({ setDodoCancellation: mocks.provider }));
vi.mock("@/lib/rate-limit", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/rate-limit")>(), checkRateLimit: mocks.limit }));
const request = (body = "{}", headers: Record<string, string> = {}) => new Request("https://app.dummy/api/billing/cancel", {
  method: "POST", headers: { origin: "https://app.dummy", "content-type": "application/json", ...headers }, body,
});
beforeEach(() => {
  vi.resetAllMocks();
  for (const [name, value] of Object.entries({ CODENAYA_DEPLOYMENT: "development", DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    DODO_PAYMENTS_BUSINESS_ID: "bus_dummy", DODO_PAYMENTS_API_KEY: "dummy-canary", DODO_PAYMENTS_PRO_PRODUCT_ID: "pro_dummy",
    CODENAYA_CONVEX_INTERNAL_KEY: "dummy-internal", CODENAYA_BILLING_ENABLED: "false", CREDIT_LIMITS_ENFORCED: "false" })) vi.stubEnv(name, value);
  mocks.user.mockResolvedValue({ userId: "alice" });
  mocks.auth.mockResolvedValue({ getToken: vi.fn().mockResolvedValue("dummy-token") });
  mocks.limit.mockReturnValue({ allowed: true });
  mocks.mutation.mockResolvedValueOnce({ kind: "call", subscriptionRef: "subref", subscriptionId: "sub_dummy", customerId: "cus_alice", revision: 1 }).mockResolvedValue(null);
  mocks.provider.mockResolvedValue({ kind: "confirmed", cancelAtNextBillingDate: true, status: "active" });
});
afterEach(() => { vi.unstubAllEnvs(); });
it.each([[cancel, "period_end"], [uncancel, "resume"]] as const)("management works with checkout disabled", async (route, timing) => {
  const response = await route(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "confirmed" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_alice" }), { subscriptionId: "sub_dummy", timing });
  expect(mocks.mutation.mock.calls[0][2]).toEqual({ token: "dummy-token" });
});
it.each([
  ["{", {}, 400], ['{"subscriptionId":"sub_foreign"}', {}, 400], ['{"timing":"immediate"}', {}, 400],
  ["{}", { origin: "https://foreign.dummy" }, 403], ["{}", { "content-type": "text/plain" }, 415],
] as const)("rejects malformed/foreign requests", async (body, headers, status) => {
  const response = await cancel(request(body, headers));
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.provider).not.toHaveBeenCalled();
});
it("signed-out and rate-limited requests never prepare", async () => {
  mocks.user.mockResolvedValueOnce({ unauthorized: Response.json({ error: "Unauthorized" }, { status: 401 }) });
  expect((await cancel(request())).status).toBe(401);
  mocks.limit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
  expect((await cancel(request())).status).toBe(429);
  expect(mocks.mutation).not.toHaveBeenCalled();
});
it("configuration failure is 503", async () => {
  vi.stubEnv("DODO_PAYMENTS_API_KEY", "PLACEHOLDER_dummy");
  expect((await cancel(request())).status).toBe(503);
  expect(mocks.provider).not.toHaveBeenCalled();
});
it.each(["not_subscribed", "on_hold", "control_pending", "expired"])("returns typed refusal %s", async code => {
  mocks.mutation.mockReset().mockResolvedValue({ kind: "refused", code });
  const response = await uncancel(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code });
  expect(mocks.provider).not.toHaveBeenCalled();
});
it("unknown or failed result recording stays pending", async () => {
  mocks.provider.mockResolvedValue({ kind: "unknown" });
  expect((await cancel(request())).status).toBe(202);
  mocks.mutation.mockReset().mockResolvedValueOnce({ kind: "call", subscriptionRef: "subref", subscriptionId: "sub_dummy", customerId: "cus_alice", revision: 2 }).mockRejectedValueOnce(new Error("dummy"));
  expect((await cancel(request())).status).toBe(202);
});
it("user routes cannot select immediate cancellation", () => {
  for (const path of ["src/app/api/billing/cancel/route.ts", "src/app/api/billing/uncancel/route.ts", "src/features/billing/server/subscription-route.ts"]) {
    expect(readFileSync(path, "utf8")).not.toMatch(/["']immediate["']/);
  }
});
