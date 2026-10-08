import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  openProviderKey: vi.fn(),
  buildAiSdkModel: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("./sealed-key", () => ({ openProviderKey: mocks.openProviderKey }));
vi.mock("./ai-sdk-model", () => ({ buildAiSdkModel: mocks.buildAiSdkModel }));

import { PROVIDER_KEY_ERROR_CODE } from "../registry";
import { resolveEditorModel, withEditorModel } from "./editor-model";
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

const resolve = () =>
  resolveEditorModel({ internalKey: "ik", userId: "user_1", task: "quickEdit" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("OPENROUTER_QUICK_EDIT_MODEL", "");
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  mocks.openProviderKey.mockResolvedValue(SECRET);
  mocks.buildAiSdkModel.mockImplementation((target) => ({ byok: target }));
});

describe("resolveEditorModel", () => {
  it("uses the platform OpenRouter model without a default key", async () => {
    mocks.query.mockResolvedValue(null);

    const resolved = await resolve();

    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      userId: "user_1",
    });
    expect(resolved?.key).toBeUndefined();
    expect(resolved?.model).toMatchObject({
      provider: "openai.chat",
      modelId: "openai/gpt-5.4-mini",
    });
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
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
    withEditorModel({ userId: "user_1", task: "suggestion" }, generate);

  it("passes the resolved model to the generation", async () => {
    mocks.query.mockResolvedValue({ key: anthropicKey, modelId: "claude-opus-5-5" });
    const generate = vi.fn(async () => Response.json({ suggestion: "x" }));

    const response = await run(generate);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledWith({
      byok: expect.objectContaining({ provider: "anthropic", model: "claude-haiku-4-5" }),
    });
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
