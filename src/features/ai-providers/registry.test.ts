import { describe, expect, it } from "vitest";

import { AGENT_MODELS, DEFAULT_AGENT_MODEL_ID } from "../conversations/agent-models";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  PLATFORM_PROVIDER,
  baseUrlFor,
  isAiProviderId,
  modelIdsFor,
  titleModelFor,
} from "./registry";

describe("AI provider registry", () => {
  it("has one entry per provider id, keyed by its own id", () => {
    expect(Object.keys(AI_PROVIDERS).sort()).toEqual([...AI_PROVIDER_IDS].sort());
    for (const id of AI_PROVIDER_IDS) {
      expect(AI_PROVIDERS[id].id).toBe(id);
      expect(AI_PROVIDERS[id].label).not.toBe("");
    }
  });

  it("gives every fixed provider an https base URL, models and a title model", () => {
    for (const id of ["openrouter", "openai", "anthropic"] as const) {
      const provider = AI_PROVIDERS[id];
      expect(new URL(provider.baseUrl!).protocol).toBe("https:");
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.titleModel).toBeTruthy();
      expect(new Set(provider.models.map((m) => m.id)).size).toBe(provider.models.length);
    }
  });

  it("reuses the agent model allowlist for OpenRouter and the platform", () => {
    expect(AI_PROVIDERS.openrouter.models.map((m) => m.id)).toEqual(
      AGENT_MODELS.map((m) => m.id),
    );
    expect(PLATFORM_PROVIDER.models).toBe(AI_PROVIDERS.openrouter.models);
    expect(PLATFORM_PROVIDER.defaultModelId).toBe(DEFAULT_AGENT_MODEL_ID);
  });

  it("uses bare model ids for direct providers, title model included", () => {
    for (const id of ["openai", "anthropic"] as const) {
      expect(AI_PROVIDERS[id].models.map((m) => m.id)).toContain(
        AI_PROVIDERS[id].titleModel,
      );
      for (const model of AI_PROVIDERS[id].models) {
        expect(model.id).not.toContain("/");
      }
    }
  });

  it("leaves custom endpoints without curated models or base URL", () => {
    expect(AI_PROVIDERS.custom.models).toEqual([]);
    expect(AI_PROVIDERS.custom.baseUrl).toBeUndefined();
  });

  it("resolves models, title model and base URL for a key", () => {
    const custom = {
      provider: "custom" as const,
      baseUrl: "https://llm.example.com/v1",
      modelIds: ["llama-4", "qwen-3"],
    };
    expect(modelIdsFor(custom)).toEqual(["llama-4", "qwen-3"]);
    expect(titleModelFor(custom)).toBe("llama-4");
    expect(baseUrlFor(custom)).toBe("https://llm.example.com/v1");

    // A fixed provider ignores any base URL on the key.
    expect(baseUrlFor({ provider: "openai", baseUrl: "https://evil.example" })).toBe(
      "https://api.openai.com/v1",
    );
    expect(modelIdsFor({ provider: "anthropic" })).toContain("claude-opus-5-5");
    expect(() => baseUrlFor({ provider: "custom" })).toThrow();
  });

  it("recognises provider ids", () => {
    expect(isAiProviderId("openai")).toBe(true);
    expect(isAiProviderId("codenaya")).toBe(false);
    expect(isAiProviderId(undefined)).toBe(false);
  });
});
