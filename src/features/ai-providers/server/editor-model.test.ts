import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  platform: vi.fn(),
  mutation: vi.fn(),
  openProviderKey: vi.fn(),
  buildAiSdkModel: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.platform), mutation: mocks.mutation } };
});
vi.mock("./sealed-key", () => ({ openProviderKey: mocks.openProviderKey }));
// Outside a request, run `after` callbacks at once.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: (task: () => unknown) => task(),
}));
vi.mock("./ai-sdk-model", () => ({ buildAiSdkModel: mocks.buildAiSdkModel }));

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

import { PROVIDER_KEY_ERROR_CODE } from "../registry";
import { UsageLimitError, resolveEditorModel, withEditorModel } from "./editor-model";
import { ProviderKeyError } from "./resolve-run-model";

const SECRET = "sk-user-secret-key-1234";

const anthropicKey = {
  _id: "key_1",
  userId: "user_1",
  provider: "anthropic" as const,
  label: "Work key",
  status: "active" as const,
};

const customKey = {
  _id: "key_2",
  userId: "user_1",
  provider: "custom" as const,
  label: "Groq",
  baseUrl: "https://api.groq.test/openai/v1",
  modelIds: ["llama-4-scout", "llama-4-maverick"],
  status: "active" as const,
};

/** Free plan, $3.00 of $3.00 used. */
const OVER_CAP = {
  planId: "free",
  costMicroUsd: 3_000_000,
  tokens: 1_000,
  costLimitMicroUsd: 3_000_000,
  exceeded: true,
  exceededBy: "usd",
};

const resolve = () =>
  resolveEditorModel({ internalKey: "ik", userId: "user_1" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  mocks.openProviderKey.mockResolvedValue(SECRET);
  mocks.buildAiSdkModel.mockImplementation((target) => ({ byok: target }));
});

describe("resolveEditorModel", () => {
  it("uses the platform provider's small model without a default key", async () => {
    mocks.query.mockResolvedValue(null);

    const resolved = await resolve();

    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      userId: "user_1",
    });
    expect(resolved?.key).toBeUndefined();
    expect(mocks.buildAiSdkModel).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: "sk-or-platform",
      model: "openai/gpt-5.4-mini",
    });
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
  });

  it("refuses platform AI over the monthly cap, naming the cap", async () => {
    mocks.query.mockResolvedValue(null);
    mocks.platform.mockReturnValue({ provider: "openrouter", config: null, usage: OVER_CAP });

    const error = await resolve().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageLimitError);
    expect((error as Error).message).toMatch(/Free plan's \$3\.00 of Codenaya AI/);
    expect(mocks.buildAiSdkModel).not.toHaveBeenCalled();
  });

  it("lets a default key through when platform usage is over the cap", async () => {
    mocks.query.mockResolvedValue({ key: anthropicKey, modelId: "claude-opus-5-5" });
    mocks.platform.mockReturnValue({ provider: "openrouter", config: null, usage: OVER_CAP });

    expect((await resolve())?.key?._id).toBe("key_1");
  });

  it("meters each platform call once, to the user, as editor usage", async () => {
    mocks.query.mockResolvedValue(null);
    mocks.buildAiSdkModel.mockReturnValue(
      new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 30, text: 30, reasoning: 0 },
          },
          warnings: [],
        },
      }),
    );

    mocks.mutation.mockResolvedValue({});
    const model = (await resolve())!.model as LanguageModelV3;
    await model.doGenerate({ prompt: [] });

    expect(mocks.mutation).toHaveBeenCalledOnce();
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      key: expect.stringMatching(/^editor:/),
      userId: "user_1",
      source: "editor",
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("returns null without a default key when the platform is not configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    mocks.query.mockResolvedValue(null);

    expect(await resolve()).toBeNull();
  });

  it("uses the default key's provider and its small model", async () => {
    mocks.query.mockResolvedValue({ key: anthropicKey, modelId: "claude-opus-5-5" });
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const resolved = await resolve();

    expect(resolved?.model).toEqual({
      byok: {
        provider: "anthropic",
        apiKey: SECRET,
        baseUrl: undefined,
        model: "claude-haiku-4-5",
      },
    });
    expect(resolved?.key).toEqual({ _id: "key_1", userId: "user_1", label: "Work key" });
  });

  it("uses the default model on a custom endpoint", async () => {
    mocks.query.mockResolvedValue({ key: customKey, modelId: "llama-4-maverick" });

    const resolved = await resolve();

    expect(resolved?.model).toEqual({
      byok: {
        provider: "custom",
        apiKey: SECRET,
        baseUrl: customKey.baseUrl,
        model: "llama-4-maverick",
      },
    });
  });

  it.each([
    ["is gone", { key: null, modelId: "claude-opus-5-5" }, /no longer exists/],
    [
      "is marked invalid",
      { key: { ...anthropicKey, status: "invalid" }, modelId: "claude-opus-5-5" },
      /Work key key was rejected/,
    ],
    ["no longer offers the model", { key: customKey, modelId: "retired" }, /no longer offers retired/],
  ])("throws a ProviderKeyError when the default key %s", async (_, byok, message) => {
    mocks.query.mockResolvedValue(byok);

    const error = await resolve().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderKeyError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).toContain("Settings → AI providers");
    expect((error as Error).message).not.toContain(SECRET);
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
  });
});

describe("withEditorModel", () => {
  const run = (generate: Parameters<typeof withEditorModel>[1]) =>
    withEditorModel({ userId: "user_1" }, generate);

  it("passes the resolved model to the generation", async () => {
    mocks.query.mockResolvedValue({ key: anthropicKey, modelId: "claude-opus-5-5" });
    const generate = vi.fn(async () => Response.json({ suggestion: "x" }));

    const response = await run(generate);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledWith({
      byok: expect.objectContaining({ provider: "anthropic", model: "claude-haiku-4-5" }),
    });
  });

  it("answers a typed 402 over the monthly cap, without calling the provider", async () => {
    mocks.query.mockResolvedValue(null);
    mocks.platform.mockReturnValue({ provider: "openrouter", config: null, usage: OVER_CAP });
    const generate = vi.fn();

    const response = await run(generate);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "usage_limit" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers 503 when AI is not configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    mocks.query.mockResolvedValue(null);
    const generate = vi.fn();

    expect((await run(generate)).status).toBe(503);
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "");
    expect((await run(generate)).status).toBe(503);
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers a typed 422 for an unusable key, without calling the provider", async () => {
    mocks.query.mockResolvedValue({ key: null, modelId: "claude-opus-5-5" });
    const generate = vi.fn();

    const response = await run(generate);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: PROVIDER_KEY_ERROR_CODE });
    expect(generate).not.toHaveBeenCalled();
  });

  it("marks a key the provider refuses invalid and answers a typed 422", async () => {
    mocks.query.mockResolvedValue({ key: anthropicKey, modelId: "claude-opus-5-5" });

    const response = await run(async () => {
      throw Object.assign(new Error("invalid x-api-key"), { statusCode: 401 });
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      error: expect.stringContaining("Work key key was rejected"),
      code: PROVIDER_KEY_ERROR_CODE,
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      keyId: "key_1",
      userId: "user_1",
      status: "invalid",
      statusMessage: expect.any(String),
    });
  });

  it("rethrows other failures, and platform failures, unchanged", async () => {
    const outage = new Error("503 Service Unavailable");
    mocks.query.mockResolvedValue({ key: anthropicKey, modelId: "claude-opus-5-5" });
    await expect(run(async () => Promise.reject(outage))).rejects.toBe(outage);

    const unauthorized = new Error("401 Unauthorized");
    mocks.query.mockResolvedValue(null);
    await expect(run(async () => Promise.reject(unauthorized))).rejects.toBe(unauthorized);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
