import { blendedUsdPerMTok, type CatalogModel } from "../ai-providers/catalog";
import type { PlatformProviderId } from "../ai-providers/platform";

/**
 * Limits and shapes of the admin's platform model catalog. Pure, so /admin
 * validates with the same numbers and rules `convex/platformCatalog.ts` enforces.
 */

export type { PlatformProviderId };

/** Bounds the config doc (about 15 KB) and the users' picker. */
export const MAX_PLATFORM_MODELS = 50;

/** Bounds on a model's display strings, from the provider or the admin. */
export const MAX_MODEL_NAME_LENGTH = 120;
export const MAX_MODEL_VENDOR_LENGTH = 60;

/** USD per 1M tokens. Far above any real price; catches a per-token value pasted ×1e6. */
export const MAX_USD_PER_MTOK = 1000;

/** A price moving more than this fraction from the saved one needs confirming. */
export const RISKY_PRICE_CHANGE_RATIO = 0.5;

const isBigChange = (price: number, before: number) =>
  Math.abs(price - before) > RISKY_PRICE_CHANGE_RATIO * before;

/**
 * Ids of the models whose price needs `confirmRiskyPrices` (ADR 0010): a new
 * or changed $0 blended price, or one more than `RISKY_PRICE_CHANGE_RATIO`
 * away from the saved price of the same id (blended, or either side of two
 * split prices, so $4/$20 → $8/$8 asks too). An unchanged price never asks
 * again, so free models don't prompt on every save.
 */
export const riskyPriceModelIds = (
  saved: readonly Pick<CatalogModel, "id" | "pricing">[],
  models: readonly Pick<CatalogModel, "id" | "pricing">[],
): string[] => {
  const savedPricing = new Map(saved.map((m) => [m.id, m.pricing]));
  return models
    .filter(({ id, pricing }) => {
      const price = blendedUsdPerMTok(pricing);
      const before = savedPricing.get(id);
      if (price === 0) return !before || blendedUsdPerMTok(before) !== 0;
      if (!before) return false;
      if (isBigChange(price, blendedUsdPerMTok(before))) return true;
      return (
        pricing.mode === "split" &&
        before.mode === "split" &&
        (isBigChange(pricing.inputUsdPerMTok, before.inputUsdPerMTok) ||
          isBigChange(pricing.outputUsdPerMTok, before.outputUsdPerMTok))
      );
    })
    .map((model) => model.id);
};

/**
 * A model as `GET /api/admin/models` returns it. `tools` and `vision` are null
 * when the provider's API doesn't say; prices only come from OpenRouter.
 */
export interface FetchedModel {
  id: string;
  name: string;
  vendor: string;
  contextLength?: number;
  vision: boolean | null;
  tools: boolean | null;
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
}
