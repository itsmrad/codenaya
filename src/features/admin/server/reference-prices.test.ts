import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchReferencePrices,
  normalizeModelName,
  referencePriceIndex,
  withReferencePrices,
} from "./reference-prices";

const openRouterRow = (id: string, name: string, prompt: string, completion: string) => ({
  id,
  name,
  pricing: { prompt, completion },
});

describe("reference prices", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes names across providers", () => {
    expect(normalizeModelName("Anthropic: Claude Opus 5.5")).toBe("claudeopus55");
    expect(normalizeModelName("Claude Opus 5.5")).toBe("claudeopus55");
    expect(normalizeModelName("gpt-5.4-mini")).toBe("gpt54mini");
    expect(normalizeModelName("OpenAI: GPT-5.4 Mini")).toBe("gpt54mini");
  });

  it("matches by display name or by id, blended 3:1, and skips free rows", () => {
    const index = referencePriceIndex([
      { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", vendor: "anthropic", vision: true, tools: true, inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
      { id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b", vendor: "openai", vision: false, tools: true, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
      { id: "meta/llama:free", name: "Meta: Llama (free)", vendor: "meta", vision: false, tools: true, inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      { id: "x/unpriced", name: "Unpriced", vendor: "x", vision: false, tools: true },
    ]);

    const models = withReferencePrices(
      [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", vendor: "anthropic", vision: false, tools: true },
        { id: "openai/gpt-oss-120b", name: "openai/gpt-oss-120b", vendor: "openai", vision: null, tools: null },
        { id: "llama", name: "Llama (free)", vendor: "meta", vision: null, tools: null },
        { id: "unpriced", name: "Unpriced", vendor: "x", vision: null, tools: null },
      ],
      index,
    );

    expect(models.map((m) => m.referencePrice)).toEqual([8, 0.2, undefined, undefined]);
  });

  it("prefers the id key and drops a name two rows price differently", () => {
    const row = (id: string, name: string, price: number) => ({
      id, name, vendor: "x", vision: false, tools: true, inputUsdPerMTok: price, outputUsdPerMTok: price,
    });
    const index = referencePriceIndex([row("x/fast-a", "X: Fast", 1), row("x/fast-b", "X: Fast", 2)]);

    const models = withReferencePrices(
      [
        { id: "fast-b", name: "Fast", vendor: "x", vision: null, tools: null },
        { id: "fast-c", name: "Fast", vendor: "x", vision: null, tools: null },
      ],
      index,
    );

    expect(models.map((m) => m.referencePrice)).toEqual([2, undefined]);
  });

  it("fetches OpenRouter's public list without a key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [openRouterRow("openai/gpt-5", "OpenAI: GPT-5", "0.000001", "0.000005")] }));
    vi.stubGlobal("fetch", fetchMock);

    const index = await fetchReferencePrices();

    expect(index.get("gpt5")).toBe(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init.headers).toBeUndefined();
  });

  it.each([
    ["an error status", () => Promise.resolve(new Response("down", { status: 503 }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["an unreadable body", () => Promise.resolve(new Response("not json"))],
  ])("gives no references on %s", async (_, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));
    expect((await fetchReferencePrices()).size).toBe(0);
  });
});
