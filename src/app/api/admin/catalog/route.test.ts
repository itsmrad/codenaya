import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  has: vi.fn(),
  getToken: vi.fn(),
  fetchQuery: vi.fn(),
  fetchMutation: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs/server")>()),
  auth: mocks.auth,
}));
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery, fetchMutation: mocks.fetchMutation }));

import { resetRateLimits } from "@/lib/rate-limit";

import { POST } from "./route";

const ORIGIN = "http://localhost";

const model = (overrides: Record<string, unknown> = {}) => ({
  id: "anthropic/claude-sonnet-5.5",
  name: "Claude Sonnet 5.5",
  vendor: "anthropic",
  provider: "openrouter",
  providerModelId: "anthropic/claude-sonnet-5.5",
  vision: true,
  tools: "reported",
  pricing: { mode: "blended", usdPerMTok: 6 },
  access: "everyone",
  hidden: false,
  ...overrides,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  models: [model()],
  defaultModelId: "anthropic/claude-sonnet-5.5",
  utilityModelId: "anthropic/claude-sonnet-5.5",
  confirmRiskyPrices: false,
  ...overrides,
});

const post = (json: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`${ORIGIN}/api/admin/catalog`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
      body: JSON.stringify(json),
    }),
  );

describe("POST /api/admin/catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.auth.mockResolvedValue({ userId: "user_admin", getToken: mocks.getToken, has: mocks.has });
    mocks.getToken.mockResolvedValue("jwt");
    mocks.fetchQuery.mockResolvedValue(true);
    mocks.has.mockReturnValue(true);
    mocks.fetchMutation.mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("saves as the admin, with the internal key and the request metadata", async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(mocks.fetchMutation).toHaveBeenCalledWith(
      expect.anything(),
      {
        internalKey: "internal",
        ...body(),
        request: { requestId: expect.any(String), ip: "203.0.113.7" },
      },
      { token: "jwt" },
    );
  });

  it("returns 404 to a non-admin without touching Convex", async () => {
    mocks.fetchQuery.mockResolvedValue(false);
    expect((await post(body())).status).toBe(404);
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post(body(), { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
  });

  it("asks for a step-up before saving", async () => {
    mocks.has.mockReturnValue(false);
    const res = await post(body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reverification_required" });
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
  });

  it.each([
    ["no models", body({ models: [] })],
    ["a negative price", body({ models: [model({ pricing: { mode: "blended", usdPerMTok: -1 } })] })],
    ["a split price missing a side", body({ models: [model({ pricing: { mode: "split", inputUsdPerMTok: 1 } })] })],
    ["an unknown provider", body({ models: [model({ provider: "vertex" })] })],
    ["an unknown access", body({ models: [model({ access: "vip" })] })],
    ["duplicate ids", body({ models: [model(), model()] })],
    ["a default not in the catalog", body({ defaultModelId: "nope" })],
    ["a hidden default", body({ models: [model({ hidden: true })] })],
    ["a promo utility model", body({ models: [model({ access: "promo_counted" })] })],
    ["no confirmRiskyPrices", { ...body(), confirmRiskyPrices: undefined }],
  ])("rejects %s with 400", async (_, json) => {
    expect((await post(json)).status).toBe(400);
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
  });

  it("refuses a route whose provider key isn't set, naming the variable only in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(
      body({
        models: [model(), model({ id: "claude-opus-5-5", provider: "anthropic", providerModelId: "claude-opus-5-5" })],
      }),
    );
    const text = await res.text();

    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toMatchObject({ code: "key_missing", provider: "anthropic" });
    expect(text).not.toContain("ANTHROPIC_API_KEY");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    [{ code: "NOT_FOUND", message: "Not found" }, 404, undefined],
    [{ code: "INVALID_ARGUMENT", message: "Unknown utility model" }, 400, "invalid_catalog"],
    [{ code: "CONFLICT", message: "Confirm the price changes", reason: "risky_price" }, 409, "risky_price"],
    [{ code: "CONFLICT", message: "Something else" }, 409, "conflict"],
  ])("maps Convex's %o", async (data, status, code) => {
    mocks.fetchMutation.mockRejectedValue(new ConvexError(data));
    const res = await post(body());
    expect(res.status).toBe(status);
    if (code) expect(await res.json()).toMatchObject({ code, error: data.message });
  });

  it("passes confirmRiskyPrices through on the resend", async () => {
    await post(body({ confirmRiskyPrices: true }));
    expect(mocks.fetchMutation.mock.calls[0][1]).toMatchObject({ confirmRiskyPrices: true });
  });

  it("rethrows anything else", async () => {
    mocks.fetchMutation.mockRejectedValue(new Error("boom"));
    await expect(post(body())).rejects.toThrow("boom");
  });
});
