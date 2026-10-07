import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  openProviderKey: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("./sealed-key", () => ({ openProviderKey: mocks.openProviderKey }));

import { DEFAULT_AGENT_MODEL_ID } from "@/features/conversations/agent-models";

import {
  ModelChoiceError,
  ProviderKeyError,
  isProviderKeyRejection,
  requireModelChoice,
  resolveRunModel,
  validateModelChoice,
} from "./resolve-run-model";

const SECRET = "sk-user-secret-key-1234";

const openAiKey = {
  _id: "key_1",
  userId: "user_1",
  provider: "openai" as const,
  label: "Work key",
  status: "active" as const,
};

const customKey = {
  _id: "key_2",
  userId: "user_1",
  provider: "custom" as const,
  label: "Groq",
  baseUrl: "https://api.groq.test/openai/v1",
  modelIds: ["llama-4-scout"],
  status: "active" as const,
};

/** The model and endpoint an AgentKit adapter was built for. */
const target = (model: unknown) => {
  const { url, authKey, options } = model as {
    url: string;
    authKey: string;
    options: { model: string };
  };
  return { url, id: options.model, authKey };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  mocks.openProviderKey.mockResolvedValue(SECRET);
});

describe("validateModelChoice (API route)", () => {
  const validate = (model: Parameters<typeof validateModelChoice>[0]["model"]) =>
    validateModelChoice({ internalKey: "ik", userId: "user_1", model });

  it("keeps the allowlist fallback for platform models, string or object", async () => {
    expect(await validate("anthropic/claude-opus-5.5")).toEqual({
      modelId: "anthropic/claude-opus-5.5",
      label: "Codenaya · Claude Opus 5.5",
    });
    expect(await validate({ modelId: "evil/model" })).toMatchObject({
      modelId: DEFAULT_AGENT_MODEL_ID,
    });
    expect(await validate(undefined)).toMatchObject({ modelId: DEFAULT_AGENT_MODEL_ID });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("refuses a key the caller does not own with 403", async () => {
    mocks.query.mockResolvedValue(null);
    await expect(validate({ keyId: "key_other", modelId: "gpt-5.6-luna" })).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      keyId: "key_other",
      userId: "user_1",
    });
  });

  it("treats a malformed key id like a foreign one", async () => {
    mocks.query.mockRejectedValue(new Error("ArgumentValidationError"));
    await expect(validate({ keyId: "nope", modelId: "x" })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a model the key's provider does not offer with 400", async () => {
    mocks.query.mockResolvedValue(openAiKey);
    await expect(
      validate({ keyId: "key_1", modelId: "openai/gpt-5.6-luna" }),
    ).rejects.toMatchObject({ status: 400 });

    mocks.query.mockResolvedValue(customKey);
    await expect(validate({ keyId: "key_2", modelId: "gpt-5.6-luna" })).rejects.toBeInstanceOf(
      ModelChoiceError,
    );
  });

  it("accepts an owned key with one of its models, labelled for the run block", async () => {
    mocks.query.mockResolvedValue(openAiKey);
    expect(await validate({ keyId: "key_1", modelId: "gpt-5.6-luna" })).toEqual({
      keyId: "key_1",
      modelId: "gpt-5.6-luna",
      label: "OpenAI · GPT-5.6 Luna",
    });

    mocks.query.mockResolvedValue(customKey);
    expect(await validate({ keyId: "key_2", modelId: "llama-4-scout" })).toMatchObject({
      label: "Groq · llama-4-scout",
    });
  });

  it("maps refusals to JSON responses for routes", async () => {
    mocks.query.mockResolvedValue(null);
    const { rejected } = await requireModelChoice({
      internalKey: "ik",
      userId: "user_1",
      model: { keyId: "key_other", modelId: "gpt-5.6-luna" },
    });
    expect(rejected?.status).toBe(403);
    expect(await rejected?.json()).toEqual({ error: "AI provider key not found" });
  });
});

describe("resolveRunModel (agent run)", () => {
  const resolve = (choice: { keyId?: string; modelId: string }) =>
    resolveRunModel({ internalKey: "ik", projectId: "p1" as never, choice });

  it("runs platform choices on the platform OpenRouter key", async () => {
    const run = await resolve({ modelId: "x-ai/grok-4.7" });

    expect(run.key).toBeUndefined();
    expect(target(run.coding(0.3))).toMatchObject({
      id: "x-ai/grok-4.7",
      authKey: "sk-or-platform",
    });
    expect(target(run.title(0)).url).toContain("openrouter.ai");
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
  });

  it("builds BYOK models on the user's key and provider, title on its cheap model", async () => {
    mocks.query.mockResolvedValue(openAiKey);
    const run = await resolve({ keyId: "key_1", modelId: "gpt-6.1-sol" });

    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      keyId: "key_1",
      projectId: "p1",
    });
    expect(run.key).toEqual({ _id: "key_1", userId: "user_1", label: "Work key" });
    // The summary carries no key material.
    expect(JSON.stringify(run.key)).not.toContain(SECRET);
    expect(target(run.coding(0.3))).toMatchObject({
      id: "gpt-6.1-sol",
      authKey: SECRET,
    });
    expect(target(run.coding()).url).toContain("api.openai.com");
    expect(target(run.title(0)).id).toBe("gpt-5.4-mini");
  });

  it("uses a custom endpoint's base URL and first model for titles", async () => {
    mocks.query.mockResolvedValue(customKey);
    const run = await resolve({ keyId: "key_2", modelId: "llama-4-scout" });

    expect(target(run.coding()).url).toContain("api.groq.test");
    expect(target(run.title()).id).toBe("llama-4-scout");
  });

  it.each([
    ["a key not owned by the project owner (or deleted)", null, "llama-4-scout"],
    ["a key marked invalid", { ...customKey, status: "invalid" }, "llama-4-scout"],
    ["a model the key no longer offers", customKey, "gpt-5.6-luna"],
  ])("fails with a settings link, no platform fallback, for %s", async (_, row, modelId) => {
    mocks.query.mockResolvedValue(row);

    const error = await resolve({ keyId: "key_2", modelId }).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderKeyError);
    expect(error.message).toContain("(/settings/ai-providers)");
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
  });
});

describe("isProviderKeyRejection", () => {
  it.each([
    new Error("Incorrect API key provided: sk-abc***"),
    new Error("invalid x-api-key"),
    new Error("No auth credentials found"),
    new Error("Insufficient credits. Add more using https://openrouter.ai/credits"),
    new Error("You exceeded your current quota, please check your plan"),
    new Error("Your credit balance is too low to access the Anthropic API."),
    new Error("This request requires more credits, or fewer max_tokens."),
    { message: "step failed", cause: { status: 401 } },
    { error: { message: "Request failed with status 402" } },
  ])("treats %o as the key's fault", (error) => {
    expect(isProviderKeyRejection(error)).toBe(true);
  });

  it.each([
    new Error("Rate limit reached for requests"),
    new Error("The server had an error while processing your request"),
    new Error("fetch failed"),
    undefined,
  ])("leaves %o to the normal failure path", (error) => {
    expect(isProviderKeyRejection(error)).toBe(false);
  });
});
