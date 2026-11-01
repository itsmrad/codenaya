import type { Infer } from "convex/values";

import type {
  catalogModelValidator,
  modelAccessValidator,
  modelPricingValidator,
} from "../../../convex/schema";

/**
 * The platform model catalog (ADR 0010): each model names the provider route
 * that serves it and its price. Pure and client-safe: Convex validates with
 * it, the server resolves runs with it, the pickers and /admin render it.
 */

export type CatalogModel = Infer<typeof catalogModelValidator>;
export type ModelPricing = Infer<typeof modelPricingValidator>;
export type ModelAccess = Infer<typeof modelAccessValidator>;

/** What users' pickers get: no provider route, no price (`platformCatalog.getForUsers`). */
export type PublicCatalogModel = Pick<
  CatalogModel,
  "id" | "name" | "vendor" | "vision" | "contextLength" | "access"
>;

/**
 * Input tokens weighed against output in a blended price: agent runs read far
 * more than they write. The usual 3:1 mix, e.g. $4 in / $20 out → $8.
 */
export const BLEND_INPUT_WEIGHT = 3;

/** One USD-per-1M-tokens number from separate input and output prices. */
export const blendPrices = (inputUsdPerMTok: number, outputUsdPerMTok: number) =>
  (BLEND_INPUT_WEIGHT * inputUsdPerMTok + outputUsdPerMTok) / (BLEND_INPUT_WEIGHT + 1);

/** A route's price as one number, whatever its mode: what /admin shows by default. */
export const blendedUsdPerMTok = (pricing: ModelPricing) =>
  pricing.mode === "blended"
    ? pricing.usdPerMTok
    : blendPrices(pricing.inputUsdPerMTok, pricing.outputUsdPerMTok);

/** The promo run kind a model's access takes, or null for everyone's models. */
export const promoKindOf = (access: ModelAccess) => {
  if (access === "promo_counted") return "opus" as const;
  if (access === "promo_unlimited") return "sonnet" as const;
  return null;
};

/** The caller's standing in the GitHub promotion (ADR 0009). */
export interface PromoStanding {
  claimed: boolean;
  active: boolean;
  countedRunsLeft: number;
}

/**
 * The catalog models a user may pick: everyone's, plus promo models while
 * their claim can run them. Hidden models never.
 */
export const pickableModels = <M extends Pick<CatalogModel, "access"> & { hidden?: boolean }>(
  models: readonly M[],
  promo: PromoStanding,
): M[] =>
  models.filter((model) => {
    if (model.hidden) return false;
    if (model.access === "everyone") return true;
    if (!promo.claimed || !promo.active) return false;
    return model.access === "promo_unlimited" || promo.countedRunsLeft > 0;
  });
