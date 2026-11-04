import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_MODEL_ID } from "../conversations/agent-models";
import {
  type RoutedModel,
  envCatalog,
  platformProviderId,
  resolveCatalogModel,
  utilityModel,
} from "./platform";
import { AI_PROVIDERS } from "./registry";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("platformProviderId", () => {
  it.each([
    ["openrouter", "openrouter"],
    ["groq", "groq"],
    [" Anthropic ", "anthropic"],
  ])("reads %j as %s", (value, expected) => {
    vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", value);
    expect(platformProviderId()).toBe(expected);
  });

  it("defaults to openrouter when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", "");
    expect(platformProviderId()).toBe("openrouter");
  });

  it("falls back to openrouter on an invalid value, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of ["vertex", "custom", "codenaya"]) {
      vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", value);
      expect(platformProviderId()).toBe("openrouter");
    }
    // Logged once, not on every request.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/NEXT_PUBLIC_AI_PROVIDER="vertex"/);
  });
});

describe("envCatalog", () => {
  it("routes every curated model to the env provider, for everyone", () => {
    const catalog = envCatalog("groq");

    expect(catalog.defaultModelId).toBe(AI_PROVIDERS.groq.defaultModel);
    expect(catalog.models.map((model) => model.id)).toEqual(
      AI_PROVIDERS.groq.models.map((model) => model.id),
    );
    expect(catalog.models[0]).toEqual({
      id: "openai/gpt-oss-120b",
      name: "GPT-OSS 120B",
      vendor: "OpenAI",
      vision: false,
      provider: "groq",
      providerModelId: "openai/gpt-oss-120b",
      access: "everyone",
      hidden: false,
    });
    // A curated model without a vendor is the provider's own.
    expect(envCatalog("anthropic").models[0]?.vendor).toBe("Anthropic");
  });

  it("uses the title model as the utility model, hidden when users can't pick it", () => {
    expect(utilityModel(envCatalog("groq"))).toMatchObject({ id: "openai/gpt-oss-20b", hidden: false });
    expect(utilityModel(envCatalog("openrouter"))).toMatchObject({
      id: "openai/gpt-5.4-mini",
      provider: "openrouter",
      hidden: true,
    });
  });
});

describe("resolveCatalogModel", () => {
  const model = (id: string, extra: Partial<RoutedModel> = {}): RoutedModel => ({
    id,
    name: id,
    vendor: "v",
    vision: false,
    provider: "openrouter",
    providerModelId: id,
    access: "everyone",
    hidden: false,
    ...extra,
  });

  it("keeps an offered model", () => {
    expect(resolveCatalogModel(envCatalog("openrouter"), "x-ai/grok-4.7").id).toBe("x-ai/grok-4.7");
  });

  it.each([undefined, "", "openai/not-a-real-model", "OPENAI/GPT-5.6-LUNA", " openai/gpt-5.6-luna"])(
    "falls back to the default for %j",
    (id) => {
      expect(resolveCatalogModel(envCatalog("openrouter"), id).id).toBe(DEFAULT_AGENT_MODEL_ID);
    },
  );

  it("never offers a hidden model, even as the default", () => {
    const catalog = {
      models: [model("secret", { hidden: true }), model("a"), model("b")],
      defaultModelId: "b",
    };
    expect(resolveCatalogModel(catalog, "secret").id).toBe("b");
    expect(resolveCatalogModel({ ...catalog, defaultModelId: "secret" }, "gone").id).toBe("a");
    // The env catalog's hidden utility model isn't pickable either.
    expect(resolveCatalogModel(envCatalog("openrouter"), "openai/gpt-5.4-mini").id).toBe(
      DEFAULT_AGENT_MODEL_ID,
    );
  });

  it("falls back to the first offered model when the default is gone", () => {
    expect(resolveCatalogModel({ models: [model("a"), model("b")], defaultModelId: "gone" }, "x").id)
      .toBe("a");
  });

  it("takes the utility model by id even when hidden, else the default", () => {
    const models = [model("a"), model("mini", { hidden: true })];
    expect(utilityModel({ models, defaultModelId: "a", utilityModelId: "mini" }).id).toBe("mini");
    expect(utilityModel({ models, defaultModelId: "a", utilityModelId: "gone" }).id).toBe("a");
  });
});
