import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  account: vi.fn(),
  fetch: vi.fn(),
  openProviderKey: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return {
    convex: { query: withEnvPlatform(mocks.query, undefined, mocks.account), mutation: mocks.mutation },
  };
});
vi.mock("@/features/ai-providers/server/sealed-key", () => ({ openProviderKey: mocks.openProviderKey }));

import { TRANSCRIBE_RATE_LIMIT, resetRateLimits } from "@/lib/rate-limit";

import { POST, TRANSCRIBE_MAX_BYTES, TRANSCRIBE_MODEL } from "./route";

const clip = (size = 2_000, type = "audio/webm;codecs=opus") => new Blob([new Uint8Array(size)], { type });

const post = (audio: Blob | null = clip(), language?: string) => {
  const form = new FormData();
  if (audio) form.set("audio", audio);
  if (language) form.set("language", language);
  return POST(new Request("http://localhost/api/transcribe", { method: "POST", body: form }));
};

const providerSays = (status: number, body: unknown = {}) =>
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));

/** The JSON body the route sent to the provider. */
const sentBody = () => JSON.parse(mocks.fetch.mock.calls[0]?.[1].body as string);

const OWN_KEY = { _id: "key_1", provider: "openrouter", status: "valid", label: "My OpenRouter" };

describe("POST /api/transcribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetRateLimits();
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
    vi.stubEnv("CREDIT_LIMITS_ENFORCED", "true");
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    // No default key of their own: the platform key transcribes.
    mocks.query.mockResolvedValue(null);
    mocks.account.mockReturnValue(null);
    mocks.mutation.mockResolvedValue(null);
    providerSays(200, { text: " Make the header sticky ", usage: { cost: 0.0002, seconds: 12 } });
  });

  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });

    const res = await post();

    expect(res.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("transcribes on the platform key and charges credits", async () => {
    const res = await post(clip(), "de");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Make the header sticky" });
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer sk-or-platform");
    expect(sentBody()).toMatchObject({
      model: TRANSCRIBE_MODEL,
      input_audio: { format: "webm", data: expect.any(String) },
      language: "de",
    });
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "internal",
      userId: "user_1",
      costUsd: 0.0002,
    });
  });

  it("sends no language hint on Auto or for a language the model doesn't know", async () => {
    await post(clip(), "ja");

    expect(sentBody()).not.toHaveProperty("language");
  });

  it("refuses audio over the size cap, an empty clip and an unknown format", async () => {
    expect((await post(clip(TRANSCRIBE_MAX_BYTES + 1))).status).toBe(413);
    expect((await post(null)).status).toBe(400);
    expect((await post(clip(10, "audio/flac"))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rate limits", async () => {
    for (let i = 0; i < TRANSCRIBE_RATE_LIMIT.limit; i++) await post();

    const res = await post();

    expect(res.status).toBe(429);
    expect(mocks.fetch).toHaveBeenCalledTimes(TRANSCRIBE_RATE_LIMIT.limit);
  });

  it("refuses with 402 when the day's credits are used up", async () => {
    mocks.account.mockReturnValue({
      plan: "free",
      periodStartsAt: 0,
      periodUsed: 0,
      dayStartsAt: new Date().setUTCHours(0, 0, 0, 0),
      dayUsed: 10_000,
    });

    const res = await post();

    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("insufficient_credits");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("runs free on the user's own OpenRouter key, whatever their credits", async () => {
    mocks.query.mockResolvedValue({ key: OWN_KEY, modelId: "x" });
    mocks.openProviderKey.mockResolvedValue("sk-or-own");
    mocks.account.mockReturnValue({ plan: "free", periodStartsAt: 0, periodUsed: 0, dayStartsAt: Date.now(), dayUsed: 10_000 });

    const res = await post();

    expect(res.status).toBe(200);
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer sk-or-own");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("answers 502 in plain words when the provider fails, and charges nothing", async () => {
    providerSays(500, { error: "boom" });

    const res = await post();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Transcription failed, try again.", code: "transcription_failed" });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("answers 502 and charges nothing when the provider times out or is unreachable", async () => {
    mocks.fetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    const res = await post();

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("transcription_failed");
    expect(mocks.fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("stops reading a chunked upload with no content-length at the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > 2 * TRANSCRIBE_MAX_BYTES) controller.close();
      },
    });
    const request = new Request("http://localhost/api/transcribe", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    const res = await POST(request);

    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(2 * TRANSCRIBE_MAX_BYTES);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("charges by the reported seconds when the cost isn't a number", async () => {
    providerSays(200, { text: "hi", usage: { cost: "0.1", seconds: 60 } });

    await post();

    expect(mocks.mutation.mock.calls[0]?.[1].costUsd).toBeCloseTo(0.0015);
  });

  it("points to settings when the provider refuses the user's own key", async () => {
    mocks.query.mockResolvedValue({ key: OWN_KEY, modelId: "x" });
    mocks.openProviderKey.mockResolvedValue("sk-or-own");
    providerSays(401);

    const res = await post();

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Settings → AI providers/);
  });

  it("answers 503 when no key can transcribe", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const res = await post();

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("transcription_unavailable");
  });
});
