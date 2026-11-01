import { describe, expect, it } from "vitest";

import { pickableModels, promoModelIds } from "./catalog";

const models = [
  { id: "everyone", access: "everyone" as const },
  { id: "hidden", access: "everyone" as const, hidden: true },
  { id: "opus", access: "promo_counted" as const },
  { id: "sonnet", access: "promo_unlimited" as const, hidden: true },
];

describe("user catalog", () => {
  it("offers only everyone's visible models, never promo models", () => {
    expect(pickableModels(models).map((model) => model.id)).toEqual(["everyone"]);
  });

  it("lists promo models, so a saved pick of one is switched", () => {
    expect(promoModelIds(models)).toEqual(["opus", "sonnet"]);
  });
});
