import { describe, expect, it } from "vitest";

import { AGENT_MODELS, DEFAULT_AGENT_MODEL_ID } from "../conversations/agent-models";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  baseUrlFor,
  isAiProviderId,
  keyDisplayName,
  keyGroupLabel,
  modelIdsFor,
  pickerKeys,
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
    for (const id of ["openrouter", "openai", "anthropic", "groq"] as const) {
      const provider = AI_PROVIDERS[id];
      expect(new URL(provider.baseUrl!).protocol).toBe("https:");
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.titleModel).toBeTruthy();
      expect(provider.models.map((m) => m.id)).toContain(provider.defaultModel);
      expect(new Set(provider.models.map((m) => m.id)).size).toBe(provider.models.length);
    }
  });

  it("reuses the agent model allowlist for OpenRouter", () => {
    expect(AI_PROVIDERS.openrouter.models.map((m) => m.id)).toEqual(
      AGENT_MODELS.map((m) => m.id),
    );
    expect(AI_PROVIDERS.openrouter.defaultModel).toBe(DEFAULT_AGENT_MODEL_ID);
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

describe("model picker key groups (#600)", () => {
  const key = (overrides: Partial<Parameters<typeof pickerKeys>[0][number]> = {}) => ({
    _id: "k1",
    provider: "anthropic" as const,
    label: "Anthropic",
    maskedPreview: "••••3f2a",
    status: "active" as const,
    ...overrides,
  });

  it("does not repeat the provider name when the label is the default one", () => {
    expect(keyGroupLabel(key())).toBe("Anthropic · Your key ••••3f2a");
    expect(keyGroupLabel(key({ label: " anthropic " }))).toBe("Anthropic · Your key ••••3f2a");
    expect(keyDisplayName(key())).toBe("Your key ••••3f2a");
  });

  it("keeps a label the user chose, and flags an invalid key", () => {
    expect(keyGroupLabel(key({ label: "Work" }))).toBe("Anthropic · Work");
    expect(keyGroupLabel(key({ label: "Work", status: "invalid" }))).toBe("Anthropic · Work (invalid)");
  });

  it("lists the same key added twice once, keeping the selected one", () => {
    const keys = [key({ _id: "a" }), key({ _id: "b" })];
    expect(pickerKeys(keys).map((k) => k._id)).toEqual(["a"]);
    expect(pickerKeys(keys, "b").map((k) => k._id)).toEqual(["b"]);
  });

  it("keeps keys that are distinct routes", () => {
    const keys = [
      key({ _id: "a" }),
      key({ _id: "b", maskedPreview: "••••9c1d" }),
      key({ _id: "c", label: "Work" }),
      key({ _id: "d", provider: "custom", label: "Mine", baseUrl: "https://a.example/v1", modelIds: ["m"] }),
      key({ _id: "e", provider: "custom", label: "Mine", baseUrl: "https://b.example/v1", modelIds: ["m"] }),
      key({ _id: "f", provider: "custom", label: "Mine", baseUrl: "https://a.example/v1", modelIds: ["n"] }),
    ];
    expect(pickerKeys(keys).map((k) => k._id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("tells keys apart by fingerprint when both have one (#614)", () => {
    const keys = [
      key({ _id: "a", fingerprint: "aaaaaaaaaaaa" }),
      key({ _id: "b", fingerprint: "bbbbbbbbbbbb" }),
      key({ _id: "c", fingerprint: "aaaaaaaaaaaa" }),
    ];
    expect(pickerKeys(keys).map((k) => k._id)).toEqual(["a", "b"]);
    expect(pickerKeys(keys, "c").map((k) => k._id)).toEqual(["b", "c"]);
  });

  it("falls back to the masked preview when a key has no fingerprint (#614)", () => {
    const keys = [key({ _id: "a" }), key({ _id: "b", fingerprint: "bbbbbbbbbbbb" })];
    expect(pickerKeys(keys).map((k) => k._id)).toEqual(["a"]);
  });

  it("hides invalid keys unless selected", () => {
    const keys = [key({ _id: "a", status: "invalid" })];
    expect(pickerKeys(keys)).toEqual([]);
    expect(pickerKeys(keys, "a").map((k) => k._id)).toEqual(["a"]);
  });
});
