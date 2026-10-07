import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_AI_MODELS,
  editorModel,
  editorModelId,
  isOpenRouterConfigured,
} from "./openrouter";

describe("editorModelId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["suggestion", "quickEdit"] as const)(
    "defaults %s to a small OpenRouter model",
    (task) => {
      vi.stubEnv(EDITOR_AI_MODELS[task].env, "");

      expect(editorModelId(task)).toBe("openai/gpt-5.4-mini");
    },
  );

  it("uses the env override when set", () => {
    vi.stubEnv("OPENROUTER_SUGGESTION_MODEL", " google/gemini-3-flash ");
    vi.stubEnv("OPENROUTER_QUICK_EDIT_MODEL", "anthropic/claude-haiku-4.5");

    expect(editorModelId("suggestion")).toBe("google/gemini-3-flash");
    expect(editorModelId("quickEdit")).toBe("anthropic/claude-haiku-4.5");
  });
});

describe("editorModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a chat model for the resolved OpenRouter id", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_QUICK_EDIT_MODEL", "");

    const model = editorModel("quickEdit");

    expect(model.modelId).toBe("openai/gpt-5.4-mini");
    expect(model.provider).toBe("openai.chat");
  });

  it("throws a message naming the variable when the key is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    expect(isOpenRouterConfigured()).toBe(false);
    expect(() => editorModel("suggestion")).toThrow(/OPENROUTER_API_KEY/);
  });
});
