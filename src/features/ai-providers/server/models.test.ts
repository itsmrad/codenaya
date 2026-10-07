import { describe, expect, it } from "vitest";

import { ANTHROPIC_MAX_TOKENS, buildAgentKitModel } from "./agentkit-model";
import { buildAiSdkModel } from "./ai-sdk-model";

describe("buildAgentKitModel", () => {
  it("routes OpenRouter through the OpenAI chat adapter", () => {
    const model = buildAgentKitModel({
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "openai/gpt-5.6-luna",
      temperature: 0.3,
    });
    expect(model.format).toBe("openai-chat");
    expect(model.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(model.authKey).toBe("sk-or-test");
    expect(model.options.defaultParameters).toEqual({ temperature: 0.3 });
  });

  it("omits default parameters when no temperature is given", () => {
    const model = buildAgentKitModel({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-5.6-luna",
    });
    expect(model.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(model.options.defaultParameters).toBeUndefined();
  });

  it("sets max_tokens for Anthropic, which requires it", () => {
    const model = buildAgentKitModel({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5-5",
      temperature: 0,
    });
    expect(model.format).toBe("anthropic");
    expect(model.url).toBe("https://api.anthropic.com/v1/messages");
    expect(model.options.defaultParameters).toEqual({
      max_tokens: ANTHROPIC_MAX_TOKENS,
      temperature: 0,
    });
  });

  it("uses the stored base URL for a custom endpoint", () => {
    const model = buildAgentKitModel({
      provider: "custom",
      apiKey: "key",
      baseUrl: "https://llm.example.com/v1",
      model: "llama-4",
    });
    expect(model.url).toBe("https://llm.example.com/v1/chat/completions");
  });
});

describe("buildAiSdkModel", () => {
  it.each([
    ["openrouter", "openai.chat", undefined],
    ["openai", "openai.responses", undefined],
    ["anthropic", "anthropic.messages", undefined],
    ["custom", "openai.chat", "https://llm.example.com/v1"],
  ] as const)("builds a %s model", (provider, sdkProvider, baseUrl) => {
    const model = buildAiSdkModel({ provider, apiKey: "key", baseUrl, model: "m-1" });
    expect(model.provider).toBe(sdkProvider);
    expect(model.modelId).toBe("m-1");
  });
});
