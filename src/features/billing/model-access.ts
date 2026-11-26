import { pickableModels } from "../ai-providers/catalog";
import type { RoutedCatalog } from "../ai-providers/platform";

/** Ordinary coding models; promo permission is checked independently. */
export function allowedOrdinaryModels(
  catalog: RoutedCatalog,
  view: { plan: "free" | "pro" },
  opts: { restrictFree: boolean },
) {
  return pickableModels(catalog.models).filter((model) =>
    !opts.restrictFree || view.plan === "pro" || model.id === catalog.defaultModelId);
}
