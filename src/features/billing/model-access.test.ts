import { expect, it } from "vitest";
import { envCatalog } from "../ai-providers/platform";
import { allowedOrdinaryModels } from "./model-access";
import { billingRolloutEnabled } from "./server/dodo-config";
it.each(["openrouter", "openai", "anthropic", "groq"] as const)("limits Free to the eligible %s default only at rollout", (provider) => {
  const catalog = envCatalog(provider);
  const all = catalog.models.filter((m) => !m.hidden && m.access === "everyone");
  expect(allowedOrdinaryModels(catalog, { plan: "free" }, { restrictFree: false })).toEqual(all);
  expect(allowedOrdinaryModels(catalog, { plan: "pro" }, { restrictFree: true })).toEqual(all);
  expect(allowedOrdinaryModels(catalog, { plan: "free" }, { restrictFree: true }).map((m) => m.id)).toEqual([catalog.defaultModelId]);
  for (const extra of [{ hidden: true }, { access: "promo_counted" as const }]) {
    const invalid = { ...catalog, models: catalog.models.map((m) => m.id === catalog.defaultModelId ? { ...m, ...extra } : m) };
    expect(allowedOrdinaryModels(invalid, { plan: "free" }, { restrictFree: true })).toEqual([]);
    expect(allowedOrdinaryModels(invalid, { plan: "pro" }, { restrictFree: true }).some((m) => m.id === catalog.defaultModelId)).toBe(false);
  }
});
it("shares checkout's exact switch semantics", () => {
  for (const value of [undefined, "", "false", "TRUE", " true "]) expect(billingRolloutEnabled({ CODENAYA_BILLING_ENABLED: value })).toBe(false);
  expect(billingRolloutEnabled({ CODENAYA_BILLING_ENABLED: "true" })).toBe(true);
});
