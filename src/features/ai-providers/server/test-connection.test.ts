import { describe, expect, it, vi } from "vitest";

import { isOutOfCredit, testConnection, testFailureResponse } from "./test-connection";

const respond = (status: number) => vi.fn().mockResolvedValue(new Response("{}", { status }));

describe("testConnection", () => {
  it.each([
    ["openrouter", undefined, "https://openrouter.ai/api/v1/key", { Authorization: "Bearer k-123" }],
    ["openai", undefined, "https://api.openai.com/v1/models", { Authorization: "Bearer k-123" }],
    [
      "anthropic",
      undefined,
      "https://api.anthropic.com/v1/models",
      { "x-api-key": "k-123", "anthropic-version": "2023-06-01" },
    ],
    ["custom", "https://llm.example.com/v1", "https://llm.example.com/v1/models", { Authorization: "Bearer k-123" }],
  ] as const)("calls the %s test endpoint", async (provider, baseUrl, url, headers) => {
    const fetchFn = respond(200);
    const result = await testConnection({ provider, apiKey: "k-123", baseUrl }, { fetchFn });

    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: "GET", headers }),
    );
  });

  it.each([401, 403])("reports HTTP %i as a rejected key", async (status) => {
    const result = await testConnection(
      { provider: "openai", apiKey: "sk-secret-value" },
      { fetchFn: respond(status) },
    );
    expect(result).toEqual({
      ok: false,
      kind: "unauthorized",
      error: "OpenAI rejected the API key.",
    });
  });

  it("reports other statuses without the response body", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("echo sk-secret-value", { status: 500 }));
    const result = await testConnection(
      { provider: "anthropic", apiKey: "sk-secret-value" },
      { fetchFn },
    );
    expect(result).toEqual({
      ok: false,
      kind: "error",
      error: "Anthropic responded with HTTP 500.",
    });
  });

  it("reports a timeout", async () => {
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const result = await testConnection(
      { provider: "openrouter", apiKey: "k" },
      { fetchFn, timeoutMs: 5 },
    );
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
  });

  it("reports a blocked or unreachable endpoint", async () => {
    const blocked = await testConnection(
      { provider: "custom", apiKey: "k", baseUrl: "https://llm.example.com/v1" },
      { fetchFn: vi.fn().mockRejectedValue(new Error("Blocked request to x: private")) },
    );
    expect(blocked).toMatchObject({ ok: false, kind: "blocked" });

    const network = await testConnection(
      { provider: "openai", apiKey: "k" },
      { fetchFn: vi.fn().mockRejectedValue(new TypeError("fetch failed")) },
    );
    expect(network).toEqual({ ok: false, kind: "network", error: "Could not reach OpenAI." });
  });
});

describe("isOutOfCredit", () => {
  const reply = (status: number, body: unknown = {}) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it.each([
    ["HTTP 402", reply(402, { error: { message: "Payment required" } })],
    [
      "OpenAI's insufficient_quota",
      reply(429, {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    ],
    [
      "Anthropic's low credit balance",
      reply(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      }),
    ],
  ])("reports %s as out of credit", async (_, fetchFn) => {
    expect(await isOutOfCredit({ provider: "openai", apiKey: "k", model: "gpt-x" }, { fetchFn })).toBe(true);
  });

  it.each([
    ["a completion", reply(200, { choices: [] })],
    ["a plain rate limit", reply(429, { error: { message: "Rate limit reached for requests" } })],
    ["a server error", reply(500)],
    ["an unreachable provider", vi.fn().mockRejectedValue(new TypeError("fetch failed"))],
  ])("leaves %s to the inference", async (_, fetchFn) => {
    expect(await isOutOfCredit({ provider: "openai", apiKey: "k", model: "gpt-x" }, { fetchFn })).toBe(false);
  });

  it.each([
    [
      "openai",
      undefined,
      "https://api.openai.com/v1/chat/completions",
      { Authorization: "Bearer k-123" },
      { max_completion_tokens: 1 },
    ],
    [
      "anthropic",
      undefined,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": "k-123", "anthropic-version": "2023-06-01" },
      { max_tokens: 1 },
    ],
    [
      "custom",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1/chat/completions",
      { Authorization: "Bearer k-123" },
      { max_tokens: 1 },
    ],
  ] as const)("probes %s with a one-token completion and no tools", async (provider, baseUrl, url, headers, cap) => {
    const fetchFn = reply(200);
    await isOutOfCredit({ provider, apiKey: "k-123", baseUrl, model: "m" }, { fetchFn });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchFn.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init).toMatchObject({ method: "POST", headers });
    expect(JSON.parse(init.body)).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      ...cap,
    });
  });

  it("answers from OpenRouter's /key when the spending limit is used up", async () => {
    const fetchFn = reply(200, { data: { limit: 5, limit_remaining: 0 } });
    expect(await isOutOfCredit({ provider: "openrouter", apiKey: "k", model: "m" }, { fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.anything());
  });

  it("probes an OpenRouter key without a spending limit", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit: null, limit_remaining: null } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }), { status: 402 }),
      );
    expect(await isOutOfCredit({ provider: "openrouter", apiKey: "k", model: "m" }, { fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenLastCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("testFailureResponse", () => {
  it("maps key and URL problems to 400 and provider problems to 502", () => {
    expect(testFailureResponse({ ok: false, kind: "unauthorized", error: "x" }).status).toBe(400);
    expect(testFailureResponse({ ok: false, kind: "blocked", error: "x" }).status).toBe(400);
    expect(testFailureResponse({ ok: false, kind: "timeout", error: "x" }).status).toBe(502);
  });
});
