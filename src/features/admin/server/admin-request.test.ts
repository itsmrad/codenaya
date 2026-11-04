import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  has: vi.fn(),
  getToken: vi.fn(),
  fetchQuery: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs/server")>()),
  auth: mocks.auth,
}));
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }));

import { resetRateLimits } from "@/lib/rate-limit";

import { ADMIN_CATALOG_SAVE_RATE_LIMIT, requestMeta, requireAdminWrite } from "./admin-request";

const ROUTE_URL = "https://codenaya.test/api/admin/catalog";

const request = (headers: Record<string, string> = {}) =>
  new Request(ROUTE_URL, {
    method: "POST",
    headers: { origin: "https://codenaya.test", "content-type": "application/json", ...headers },
    body: "{}",
  });

const guard = (req = request()) => requireAdminWrite(req, ADMIN_CATALOG_SAVE_RATE_LIMIT);

describe("requireAdminWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    mocks.auth.mockResolvedValue({ userId: "user_admin", getToken: mocks.getToken, has: mocks.has });
    mocks.getToken.mockResolvedValue("jwt");
    mocks.fetchQuery.mockResolvedValue(true);
    mocks.has.mockReturnValue(true);
  });

  it("lets the admin through with the token and request metadata", async () => {
    const result = await guard(
      request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Firefox" }),
    );
    expect(result.denied).toBeUndefined();
    expect(result.admin).toEqual({ userId: "user_admin", token: "jwt" });
    expect(result.meta).toMatchObject({ ip: "203.0.113.7", userAgent: "Firefox" });
    expect(result.meta?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.has).toHaveBeenCalledWith({ reverification: "strict" });
  });

  it.each([
    ["signed out", () => mocks.auth.mockResolvedValue({ userId: null, getToken: mocks.getToken, has: mocks.has })],
    ["not the admin", () => mocks.fetchQuery.mockResolvedValue(false)],
  ])("answers 404 when %s, before any other check", async (_, arrange) => {
    arrange();
    const { denied } = await guard(request({ origin: "https://evil.test", "content-type": "text/plain" }));
    expect(denied?.status).toBe(404);
    expect(mocks.has).not.toHaveBeenCalled();
  });

  it("refuses another origin with 403", async () => {
    const { denied } = await guard(request({ origin: "https://evil.test" }));
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toMatchObject({ code: "cross_origin" });
  });

  it("refuses a request with neither Origin nor Sec-Fetch-Site", async () => {
    const req = new Request(ROUTE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await guard(req)).denied?.status).toBe(403);
  });

  it("accepts Sec-Fetch-Site: same-origin when the Origin differs (behind a proxy)", async () => {
    const { denied } = await guard(request({ origin: "https://internal.host", "sec-fetch-site": "same-origin" }));
    expect(denied).toBeUndefined();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", ""])("answers 415 to content type %j", async (type) => {
    const { denied } = await guard(request({ "content-type": type }));
    expect(denied?.status).toBe(415);
  });

  it("accepts JSON with a charset", async () => {
    expect((await guard(request({ "content-type": "application/json; charset=utf-8" }))).denied).toBeUndefined();
  });

  it("rate limits per admin", async () => {
    for (let i = 0; i < ADMIN_CATALOG_SAVE_RATE_LIMIT.limit; i++) {
      expect((await guard()).denied).toBeUndefined();
    }
    expect((await guard()).denied?.status).toBe(429);
  });

  it("asks for a step-up with Clerk's reverification hint", async () => {
    mocks.has.mockReturnValue(false);
    const { denied } = await guard();
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toMatchObject({
      code: "reverification_required",
      clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: "strict" } },
    });
  });
});

describe("requestMeta", () => {
  it("falls back to x-real-ip, bounds the user agent and omits what's missing", () => {
    const meta = requestMeta(
      new Request(ROUTE_URL, { headers: { "x-real-ip": "198.51.100.2", "user-agent": "x".repeat(2000) } }),
    );
    expect(meta.ip).toBe("198.51.100.2");
    expect(meta.userAgent).toHaveLength(512);
    expect(requestMeta(new Request(ROUTE_URL))).toEqual({ requestId: expect.any(String) });
  });
});
