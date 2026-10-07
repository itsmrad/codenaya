import { describe, expect, it, vi } from "vitest";

import { testConnection, testFailureResponse } from "./test-connection";

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

describe("testFailureResponse", () => {
  it("maps key and URL problems to 400 and provider problems to 502", () => {
    expect(testFailureResponse({ ok: false, kind: "unauthorized", error: "x" }).status).toBe(400);
    expect(testFailureResponse({ ok: false, kind: "blocked", error: "x" }).status).toBe(400);
    expect(testFailureResponse({ ok: false, kind: "timeout", error: "x" }).status).toBe(502);
  });
});
