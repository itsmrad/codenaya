import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ user: vi.fn(), auth: vi.fn(), mutation: vi.fn(), provider: vi.fn(), limit: vi.fn() }));
vi.mock("@/features/auth/server/require-user-id", () => ({ requireUserId: mocks.user }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("convex/nextjs", () => ({ fetchMutation: mocks.mutation }));
vi.mock("@/features/billing/server/dodo-subscription", () => ({ createDodoPortal: mocks.provider }));
vi.mock("@/lib/rate-limit", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/rate-limit")>(), checkRateLimit: mocks.limit }));
const request = (body = "{}", headers: Record<string, string> = {}) => new Request("https://app.dummy/api/billing/portal", {
  method: "POST", headers: { origin: "https://app.dummy", "content-type": "application/json", ...headers }, body,
});
const link = "https://portal.test.invalid/session/dummy-canary";
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [name, value] of Object.entries({ CODENAYA_DEPLOYMENT: "development", DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    DODO_PAYMENTS_BUSINESS_ID: "bus_dummy", DODO_PAYMENTS_API_KEY: "dummy-canary", DODO_PAYMENTS_PRO_PRODUCT_ID: "pro_dummy",
    CODENAYA_CONVEX_INTERNAL_KEY: "dummy-internal", CODENAYA_BILLING_ENABLED: "false", CREDIT_LIMITS_ENFORCED: "false" })) vi.stubEnv(name, value);
  mocks.user.mockResolvedValue({ userId: "alice" });
  mocks.auth.mockResolvedValue({ getToken: vi.fn().mockResolvedValue("dummy-token") });
  mocks.limit.mockReturnValue({ allowed: true });
  mocks.mutation.mockResolvedValue({ kind: "portal", customerId: "cus_alice" });
  mocks.provider.mockResolvedValue({ url: link });
});
afterEach(() => {
  expect(console.log).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
async function respond(req = request()) {
  const response = await POST(req);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
it("returns only the owned URL with checkout and spending flags disabled", async () => {
  const response = await respond();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: link });
  expect(mocks.mutation).toHaveBeenCalledTimes(1);
  expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
    internalKey: "dummy-internal", mode: "test_mode", operation: "portal",
  }, { token: "dummy-token" });
  expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({ environment: "test_mode" }), "cus_alice");
});
it.each([
  ["{", {}, 400], ['{"customerId":"cus_bob"}', {}, 400], ['{"return_url":"https://evil.invalid"}', {}, 400],
  ["[]", {}, 400], ["null", {}, 400], ["{}", { origin: "https://foreign.dummy" }, 403],
  ["{}", { origin: "" }, 403], ["{}", { "content-type": "text/plain" }, 415],
] as const)("rejects invalid or foreign requests", async (body, headers, status) => {
  expect((await respond(request(body, headers))).status).toBe(status);
  expect(mocks.mutation).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it("rejects signed-out, tokenless and rate-limited requests", async () => {
  mocks.user.mockResolvedValueOnce({ unauthorized: Response.json({ error: "Unauthorized" }, { status: 401 }) });
  expect((await respond()).status).toBe(401);
  mocks.limit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
  expect((await respond()).status).toBe(429);
  mocks.auth.mockResolvedValueOnce({ getToken: vi.fn().mockResolvedValue(null) });
  expect((await respond()).status).toBe(401);
  expect(mocks.mutation).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it.each(["CODENAYA_DEPLOYMENT", "DODO_PAYMENTS_API_KEY", "CODENAYA_CONVEX_INTERNAL_KEY"])("fails closed for missing %s", async name => {
  vi.stubEnv(name, "");
  expect((await respond()).status).toBe(503);
  expect(mocks.mutation).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
});
it("refuses unbound/foreign/deleted owner results without provider calls", async () => {
  mocks.mutation.mockResolvedValue({ kind: "refused", code: "unavailable" });
  expect(await (await respond()).json()).toEqual({ code: "portal_unavailable" });
  expect(mocks.provider).not.toHaveBeenCalled();
});
it("withholds errors and unavailable portal links", async () => {
  mocks.provider.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error(link + "dummy-token"));
  for (let i = 0; i < 2; i++) {
    const response = await respond();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "portal_unavailable" });
  }
  mocks.mutation.mockRejectedValueOnce(new Error(link));
  expect(await (await respond()).json()).toEqual({ code: "portal_unavailable" });
});
