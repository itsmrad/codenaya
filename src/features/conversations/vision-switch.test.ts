import { describe, expect, it } from "vitest";

import { AUTO_MODEL } from "@/features/ai-providers/auto-route";
import type { PublicCatalogModel } from "@/features/ai-providers/catalog";

import { visionSwitchTarget } from "./vision-switch";

const model = (id: string, vision: boolean): PublicCatalogModel => ({
  id,
  name: `Name of ${id}`,
  vendor: "Vendor",
  vision,
  access: "everyone",
});

const HAIKU = model("anthropic/claude-haiku-5.5", false);
const SONNET = model("anthropic/claude-sonnet-5.5", true);
const FLASH = model("google/gemini-3.8-flash", true);
const LUNA = model("openai/gpt-5.6-luna", true);

describe("visionSwitchTarget", () => {
  it("offers the platform model Auto routes images to, not Auto itself", () => {
    const target = visionSwitchTarget(
      { modelId: HAIKU.id },
      { models: [AUTO_MODEL, HAIKU, LUNA, FLASH, SONNET] },
    );
    expect(target).toEqual({
      choice: { modelId: SONNET.id },
      name: SONNET.name,
      billing: "Uses your credits",
    });
  });

  it("follows the admin's Auto pool", () => {
    const target = visionSwitchTarget(
      { modelId: HAIKU.id },
      { models: [HAIKU, SONNET, LUNA], autoModelIds: [LUNA.id] },
    );
    expect(target?.choice).toEqual({ modelId: LUNA.id });
  });

  it("falls back to the first platform model that reads images", () => {
    const target = visionSwitchTarget(
      { modelId: HAIKU.id },
      { models: [AUTO_MODEL, HAIKU, model("x", false), LUNA], autoModelIds: [HAIKU.id] },
    );
    expect(target?.choice).toEqual({ modelId: LUNA.id });
  });

  it("never offers a hidden or promo model", () => {
    const target = visionSwitchTarget(
      { modelId: HAIKU.id },
      { models: [HAIKU, { ...SONNET, access: "promo_counted" }] },
    );
    expect(target).toBeUndefined();
  });

  it("is undefined when no model reads images", () => {
    expect(visionSwitchTarget({ modelId: HAIKU.id }, { models: [AUTO_MODEL, HAIKU] })).toBeUndefined();
  });

  it("stays on the same key when it has a vision model", () => {
    const key = { _id: "key1", provider: "openai" as const, label: "Work" };
    const target = visionSwitchTarget({ keyId: key._id, modelId: "o-text" }, { models: [SONNET] }, key);
    expect(target).toEqual({
      choice: { keyId: "key1", modelId: "gpt-5.6-luna" },
      name: "GPT-5.6 Luna",
      billing: "Billed to your Work key",
    });
  });

  it("offers a platform model, with its billing, when the key has none", () => {
    const key = { _id: "key1", provider: "groq" as const, label: "Fast" };
    const target = visionSwitchTarget({ keyId: key._id, modelId: "openai/gpt-oss-120b" }, { models: [SONNET] }, key);
    expect(target).toEqual({ choice: { modelId: SONNET.id }, name: SONNET.name, billing: "Uses your credits" });
  });
});
