import { afterEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_PROVIDER_IDS } from "../platform";
import {
  PLATFORM_KEY_ENV,
  isPlatformConfigured,
  platformAgentModel,
  platformEditorModel,
} from "./platform-model";

/** AgentKit models keep their endpoint, key and model id on the instance. */
const target = (model: unknown) => {
  const { url, authKey, options } = model as {
    url: string;
    authKey: string;
    options: { model: string };
  };
  return { url, id: options.model, authKey };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const useProvider = (provider: string) => {
  vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", provider);
  for (const env of Object.values(PLATFORM_KEY_ENV)) vi.stubEnv(env, "");
};

describe("platform models", () => {
  it.each([
    ["openrouter", "openrouter.ai/api/v1", "openai.chat"],
    ["openai", "api.openai.com/v1", "openai.responses"],
    ["anthropic", "api.anthropic.com/v1", "anthropic.messages"],
    ["groq", "api.groq.com/openai/v1", "openai.chat"],
  ] as const)("%s reads its own key and base URL", (provider, url, editorApi) => {
    useProvider(provider);
    vi.stubEnv(PLATFORM_KEY_ENV[provider], `key-${provider}`);

    expect(isPlatformConfigured(provider)).toBe(true);
    const agent = target(platformAgentModel(provider, "some-model", 0.3));
    expect(agent).toMatchObject({ id: "some-model", authKey: `key-${provider}` });
    expect(agent.url).toContain(url);

    const editor = platformEditorModel({ provider, providerModelId: "small-model" });
    expect(editor.provider).toBe(editorApi);
    expect(editor.modelId).toBe("small-model");
  });

  it("covers every platform provider", () => {
    expect(Object.keys(PLATFORM_KEY_ENV).sort()).toEqual([...PLATFORM_PROVIDER_IDS].sort());
  });

  it("refuses without the active provider's key, naming the variable only in logs", () => {
    useProvider("groq");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-other"); // another provider's key doesn't count
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(isPlatformConfigured("groq")).toBe(false);
    expect(error.mock.calls[0][0]).toMatch(/GROQ_API_KEY is not set/);
    expect(() => platformAgentModel("groq", "openai/gpt-oss-120b")).toThrow(/GROQ_API_KEY/);
    expect(() => platformEditorModel({ provider: "groq", providerModelId: "openai/gpt-oss-20b" }))
      .toThrow(/GROQ_API_KEY/);
  });
});
