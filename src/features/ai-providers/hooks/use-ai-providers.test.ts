import { describe, expect, it } from "vitest";

import { AUTO_MODEL_ID } from "../auto-route";
import type { ModelAccess } from "../catalog";
import { platformModels } from "./use-ai-providers";

const model = (id: string, access: ModelAccess = "everyone", hidden = false) => ({
  id,
  name: id,
  vendor: "v",
  vision: true,
  access,
  hidden,
});

describe("platformModels (picker)", () => {
  it("lists Auto first when the catalog offers a build route model", () => {
    const { models, defaultModelId } = platformModels({
      models: [model("x-ai/grok-4.7"), model("openai/gpt-6.1-sol")],
      defaultModelId: "x-ai/grok-4.7",
    });

    expect(models.map((m) => m.id)).toEqual([AUTO_MODEL_ID, "x-ai/grok-4.7", "openai/gpt-6.1-sol"]);
    expect(defaultModelId).toBe("x-ai/grok-4.7");
  });

  it("leaves Auto out when every build route model is missing, hidden or promo", () => {
    const { models } = platformModels({
      models: [
        model("x-ai/grok-4.7"),
        model("anthropic/claude-sonnet-5.5", "promo_unlimited"),
        model("openai/gpt-6.1-sol", "everyone", true),
      ],
      defaultModelId: "x-ai/grok-4.7",
    });

    expect(models.map((m) => m.id)).toEqual(["x-ai/grok-4.7"]);
  });

  it("offers Auto when only the admin's Auto pool has a model it can use", () => {
    const catalog = { models: [model("x-ai/grok-4.7"), model("hidden", "everyone", true)], defaultModelId: "x-ai/grok-4.7" };

    expect(platformModels({ ...catalog, autoModelIds: ["x-ai/grok-4.7"] }).models[0]?.id).toBe(AUTO_MODEL_ID);
    expect(platformModels({ ...catalog, autoModelIds: ["hidden", "gone"] }).models.map((m) => m.id)).toEqual([
      "x-ai/grok-4.7",
    ]);
  });

  it("never makes Auto the default, even when the saved default isn't pickable", () => {
    const { defaultModelId } = platformModels({
      models: [model("anthropic/claude-opus-5.5", "promo_counted"), model("openai/gpt-6.1-sol")],
      defaultModelId: "anthropic/claude-opus-5.5",
    });

    expect(defaultModelId).toBe("openai/gpt-6.1-sol");
  });
});
