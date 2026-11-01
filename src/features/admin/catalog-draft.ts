import {
  type CatalogModel,
  type ModelPricing,
  blendPrices,
  blendedUsdPerMTok,
} from "../ai-providers/catalog";
import {
  type FetchedModel,
  MAX_USD_PER_MTOK,
  type PlatformProviderId,
  riskyPriceModelIds,
} from "./platform-models";

/**
 * The /admin editor's unsaved copy of the platform catalog (ADR 0010), and the
 * pure rules around it. Prices are kept as typed text so an empty input stays
 * empty (unpriced) instead of becoming $0. `tools: null` means the provider
 * didn't say, and Save stays blocked until the admin confirms it. The checks
 * mirror `POST /api/admin/catalog` and `platformCatalog.save`, which decide.
 */

/** A model as `GET /api/admin/models` lists it. */
export interface ListedModel extends FetchedModel {
  /** OpenRouter's blended price for the same model, where the provider has none. */
  referencePrice?: number;
}

/** The saved catalog, as `platformCatalog.getForAdmin` returns it. */
export interface SavedCatalog {
  models: CatalogModel[];
  defaultModelId: string;
  utilityModelId: string;
}

export interface DraftModel extends Omit<CatalogModel, "tools" | "pricing"> {
  tools: CatalogModel["tools"] | null;
  priceMode: ModelPricing["mode"];
  /** Blended USD/1M, as typed. */
  price: string;
  /** Split USD/1M, as typed ("Advanced"). */
  input: string;
  output: string;
  /** The price is OpenRouter's reference, not one the admin set. */
  isReferencePrice?: boolean;
}

export interface Draft {
  models: DraftModel[];
  defaultModelId: string;
  utilityModelId: string;
}

/** The body `POST /api/admin/catalog` takes. */
export interface CatalogSaveBody {
  models: CatalogModel[];
  defaultModelId: string;
  utilityModelId: string;
  confirmRiskyPrices: boolean;
}

/** USD per 1M tokens from an input, or null when empty or out of range. */
export function parsePrice(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= MAX_USD_PER_MTOK ? value : null;
}

/** The draft's price, or null while any part of it is missing or invalid. */
export function toPricing(model: DraftModel): ModelPricing | null {
  if (model.priceMode === "blended") {
    const usdPerMTok = parsePrice(model.price);
    return usdPerMTok === null ? null : { mode: "blended", usdPerMTok };
  }
  const input = parsePrice(model.input);
  const output = parsePrice(model.output);
  return input === null || output === null
    ? null
    : { mode: "split", inputUsdPerMTok: input, outputUsdPerMTok: output };
}

/** Switches "Advanced" on (split, both sides start at the blended price) or off (blended). */
export function togglePriceMode(model: DraftModel): Partial<DraftModel> {
  if (model.priceMode === "blended") {
    return { priceMode: "split", input: model.price, output: model.price };
  }
  const pricing = toPricing(model);
  return { priceMode: "blended", price: pricing ? String(Number(blendedUsdPerMTok(pricing).toFixed(6))) : "" };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why the draft can't be saved yet, empty when it can. */
export function draftProblems(draft: Draft): string[] {
  if (draft.models.length === 0) return ["Add at least one model"];
  const unpriced = draft.models.filter((m) => !toPricing(m)).length;
  const unconfirmed = draft.models.filter((m) => m.tools === null).length;
  const byId = new Map(draft.models.map((m) => [m.id, m]));
  const defaultModel = byId.get(draft.defaultModelId);
  const utilityModel = byId.get(draft.utilityModelId);
  return [
    unpriced && `Set valid prices ($0–$${MAX_USD_PER_MTOK}) for ${plural(unpriced, "model")}`,
    unconfirmed && `Confirm tool calling for ${plural(unconfirmed, "model")}`,
    (!defaultModel || defaultModel.hidden || defaultModel.access !== "everyone") &&
      "Pick a default model that everyone can use and isn't hidden",
    (!utilityModel || utilityModel.access !== "everyone") && "Pick a utility model that everyone can use",
  ].filter((problem): problem is string => !!problem);
}

export const toDraft = (saved: SavedCatalog | null): Draft => ({
  models: (saved?.models ?? []).map(({ pricing, ...model }) => ({
    ...model,
    priceMode: pricing.mode,
    price: pricing.mode === "blended" ? String(pricing.usdPerMTok) : "",
    input: pricing.mode === "split" ? String(pricing.inputUsdPerMTok) : "",
    output: pricing.mode === "split" ? String(pricing.outputUsdPerMTok) : "",
  })),
  defaultModelId: saved?.defaultModelId ?? "",
  utilityModelId: saved?.utilityModelId ?? "",
});

/** What a listed model fills in for a route on `provider`: capabilities and a blended price. */
const routeFields = (listed: ListedModel, provider: PlatformProviderId) => {
  const ownPrice =
    listed.inputUsdPerMTok !== undefined && listed.outputUsdPerMTok !== undefined
      ? Number(blendPrices(listed.inputUsdPerMTok, listed.outputUsdPerMTok).toFixed(6))
      : undefined;
  const price = ownPrice ?? listed.referencePrice;
  return {
    provider,
    providerModelId: listed.id,
    contextLength: listed.contextLength,
    // Unknown vision stays off: a wrong "on" would send images a model can't
    // read. AgentKit's Anthropic adapter is text-only.
    vision: provider !== "anthropic" && listed.vision === true,
    tools: listed.tools ? ("reported" as const) : null,
    priceMode: "blended" as const,
    price: price === undefined ? "" : String(price),
    input: "",
    output: "",
    isReferencePrice: ownPrice === undefined && listed.referencePrice !== undefined,
  };
};

/** A listed model as a new catalog row. Its list id becomes its stable `id`. Never `tools: false` rows. */
export const fromListed = (listed: ListedModel, provider: PlatformProviderId): DraftModel => ({
  id: listed.id,
  name: listed.name,
  vendor: listed.vendor,
  access: "everyone",
  hidden: false,
  ...routeFields(listed, provider),
});

/** The first model that may serve as default (visible, everyone's), else "". */
const firstDefaultable = (models: DraftModel[]) =>
  models.find((m) => m.access === "everyone" && !m.hidden)?.id ?? "";

/** Adds listed models not in the draft yet; the first one fills an empty default and utility. */
export function addModels(draft: Draft, provider: PlatformProviderId, listed: ListedModel[]): Draft {
  const ids = new Set(draft.models.map((m) => m.id));
  const models = [...draft.models, ...listed.filter((m) => !ids.has(m.id)).map((m) => fromListed(m, provider))];
  return {
    models,
    defaultModelId: draft.defaultModelId || firstDefaultable(models),
    utilityModelId: draft.utilityModelId || firstDefaultable(models),
  };
}

/** Removes a model; a default or utility it held moves to the first eligible one. */
export function removeModel(draft: Draft, id: string): Draft {
  const models = draft.models.filter((m) => m.id !== id);
  return {
    models,
    defaultModelId: draft.defaultModelId === id ? firstDefaultable(models) : draft.defaultModelId,
    utilityModelId: draft.utilityModelId === id ? firstDefaultable(models) : draft.utilityModelId,
  };
}

/** Moves a model to another route; `id`, name, access and visibility stay. */
export const reroute = (model: DraftModel, provider: PlatformProviderId, listed: ListedModel): DraftModel => ({
  ...model,
  ...routeFields(listed, provider),
});

/** The request body for a draft with no `draftProblems`. */
export const toSaveBody = (draft: Draft, confirmRiskyPrices: boolean): CatalogSaveBody => ({
  defaultModelId: draft.defaultModelId,
  utilityModelId: draft.utilityModelId,
  confirmRiskyPrices,
  models: draft.models.map((model) => ({
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    provider: model.provider,
    providerModelId: model.providerModelId,
    ...(model.contextLength === undefined ? {} : { contextLength: model.contextLength }),
    vision: model.vision,
    tools: model.tools ?? "confirmed",
    pricing: toPricing(model)!,
    access: model.access,
    hidden: model.hidden,
  })),
});

/**
 * Names of the draft's models whose price needs a confirm before saving: the
 * same rule `platformCatalog.save` enforces (`riskyPriceModelIds`).
 */
export function riskyModelNames(draft: Draft, saved: SavedCatalog | null): string[] {
  const priced = draft.models.flatMap((model) => {
    const pricing = toPricing(model);
    return pricing ? [{ id: model.id, name: model.name, pricing }] : [];
  });
  const risky = new Set(riskyPriceModelIds(saved?.models ?? [], priced));
  return priced.filter((model) => risky.has(model.id)).map((model) => model.name);
}
