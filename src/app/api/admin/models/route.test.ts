import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getToken: vi.fn(),
  fetchQuery: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }));

import { resetRateLimits } from "@/lib/rate-limit";

import { GET } from "./route";

const KEY = "sk-or-very-secret";

const get = (provider = "openrouter") =>
  GET(new Request(`http://localhost/api/admin/models?provider=${provider}`));

describe("GET /api/admin/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.auth.mockResolvedValue({ userId: "user_admin", getToken: mocks.getToken });
    mocks.getToken.mockResolvedValue("jwt");
    mocks.fetchQuery.mockResolvedValue(true);
    mocks.fetch.mockResolvedValue(
      Response.json({
        data: [{ id: "a/b", name: "B", supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } }],
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["signed out", () => mocks.auth.mockResolvedValue({ userId: null, getToken: mocks.getToken })],
    ["not the admin", () => mocks.fetchQuery.mockResolvedValue(false)],
  ])("returns 404 when %s, without calling the provider", async (_, arrange) => {
    arrange();
    const res = await get();
    expect(res.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("asks Convex with the caller's convex token", async () => {
    await get();
    expect(mocks.getToken).toHaveBeenCalledWith({ template: "convex" });
    expect(mocks.fetchQuery).toHaveBeenCalledWith(expect.anything(), {}, { token: "jwt" });
  });

  it("returns normalized models and never the key", async () => {
    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      provider: "openrouter",
      models: [{ id: "a/b", tools: true, inputUsdPerMTok: 1, outputUsdPerMTok: 2 }],
    });
    expect(text).not.toContain(KEY);
  });

  it("doesn't fetch reference prices for OpenRouter, which lists its own", async () => {
    await get();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("attaches OpenRouter's price as a reference for a provider without prices", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test");
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("https://openrouter.ai")
        ? Response.json({
            data: [{ id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b", pricing: { prompt: "0.0000001", completion: "0.0000005" } }],
          })
        : Response.json({ data: [{ id: "openai/gpt-oss-120b" }, { id: "llama-3.3-70b-versatile" }] }),
    );

    const res = await get("groq");

    expect(res.status).toBe(200);
    expect((await res.json()).models).toMatchObject([
      { id: "openai/gpt-oss-120b", referencePrice: 0.2 },
      { id: "llama-3.3-70b-versatile" },
    ]);
  });

  it("lists models without references when OpenRouter is down", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test");
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("https://openrouter.ai")
        ? new Response("down", { status: 503 })
        : Response.json({ data: [{ id: "llama-3.3-70b-versatile" }] }),
    );

    const res = await get("groq");

    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([expect.not.objectContaining({ referencePrice: expect.anything() })]);
  });

  it("returns 400 for an unknown provider", async () => {
    expect((await get("vertex")).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns 503 naming the variable when that provider's key is missing", async () => {
    const res = await get("groq");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "ai_not_configured", error: expect.stringContaining("GROQ_API_KEY") });
  });

  it("returns 503 when the key is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("ai_not_configured");
  });

  it("returns 502 on an upstream error without echoing its body", async () => {
    mocks.fetch.mockResolvedValue(new Response(`upstream says ${KEY}`, { status: 500 }));
    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ code: "provider_error", status: 500 });
    expect(text).not.toContain("upstream says");
  });
});
