import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  has: vi.fn(),
  getToken: vi.fn(),
  fetchQuery: vi.fn(),
  generateText: vi.fn(),
  buildAiSdkModel: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs/server")>()),
  auth: mocks.auth,
}));
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mocks.generateText,
}));
vi.mock("@/features/ai-providers/server/ai-sdk-model", () => ({ buildAiSdkModel: mocks.buildAiSdkModel }));

import { resetRateLimits } from "@/lib/rate-limit";

import { POST } from "./route";

const KEY = "sk-ant-api03-very-secret";
const ORIGIN = "http://localhost";

const post = (json: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`${ORIGIN}/api/admin/catalog/test`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: JSON.stringify(json),
    }),
  );

const ping = { provider: "anthropic", providerModelId: "claude-opus-5-5" };

describe("POST /api/admin/catalog/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("GROQ_API_KEY", "");
    mocks.auth.mockResolvedValue({ userId: "user_admin", getToken: mocks.getToken, has: mocks.has });
    mocks.getToken.mockResolvedValue("jwt");
    mocks.fetchQuery.mockResolvedValue(true);
    mocks.has.mockReturnValue(true);
    mocks.buildAiSdkModel.mockReturnValue("model");
    mocks.generateText.mockResolvedValue({ text: "pong" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("sends a tiny request on the route's key and model and reports the latency", async () => {
    const res = await post(ping);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(mocks.buildAiSdkModel).toHaveBeenCalledWith({ provider: "anthropic", apiKey: KEY, model: "claude-opus-5-5" });
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: "model", maxOutputTokens: 16, maxRetries: 0, abortSignal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["not the admin", () => mocks.fetchQuery.mockResolvedValue(false), 404],
    ["without a fresh step-up", () => mocks.has.mockReturnValue(false), 403],
  ])("refuses a caller %s without calling the provider", async (_, arrange, status) => {
    arrange();
    expect((await post(ping)).status).toBe(status);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("refuses another origin", async () => {
    expect((await post(ping, { origin: "https://evil.test" })).status).toBe(403);
  });

  it("rejects an unknown provider", async () => {
    expect((await post({ provider: "vertex", providerModelId: "x" })).status).toBe(400);
  });

  it("refuses a provider without a key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ provider: "groq", providerModelId: "llama" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "key_missing", provider: "groq" });
    expect(mocks.generateText).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("returns the provider's refusal without any key material", async () => {
    mocks.generateText.mockRejectedValue(
      new APICallError({
        message: `invalid x-api-key: ${KEY}, also sk-proj-abc***xyz`,
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 401,
      }),
    );
    const res = await post(ping);
    const json = await res.json();

    expect(json).toMatchObject({ ok: false, error: expect.stringMatching(/^401: invalid x-api-key/) });
    expect(json.error).not.toContain("very-secret");
    expect(json.error).not.toContain("abc***xyz");
  });

  it("reports a timeout", async () => {
    mocks.generateText.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await (await post(ping)).json()).toEqual({ ok: false, error: "No answer within 15s" });
  });
});
