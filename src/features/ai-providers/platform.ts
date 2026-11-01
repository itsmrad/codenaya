import type { CatalogModel } from "./catalog";
import { AI_PROVIDERS, type ProviderModel } from "./registry";

/**
 * The Codenaya platform: the providers its catalog routes models to, and the
 * catalog rules users' pickers and the server share.
 *
 * Each catalog model names its own provider route (ADR 0010); with no catalog
 * saved, `NEXT_PUBLIC_AI_PROVIDER`'s curated models are the catalog (ADR 0005).
 * Public on purpose: it holds no secret. Client-safe; the provider keys are
 * read only in `server/platform-model.ts`.
 */

export const PLATFORM_PROVIDER_IDS = ["openrouter", "openai", "anthropic", "groq"] as const;

export type PlatformProviderId = (typeof PLATFORM_PROVIDER_IDS)[number];

/** Today's behaviour, used when the env is unset or invalid. */
export const DEFAULT_PLATFORM_PROVIDER: PlatformProviderId = "openrouter";

/**
 * A catalog model with its route, as platform runs resolve it. `pricing` is
 * set on a saved catalog and missing on the env's curated one.
 */
export type RoutedModel = Pick<
  CatalogModel,
  "id" | "name" | "vendor" | "vision" | "provider" | "providerModelId" | "access" | "hidden"
> &
  Partial<Pick<CatalogModel, "pricing">>;

/** The catalog the server routes platform runs with (`platformCatalog.getForServer`). */
export interface RoutedCatalog {
  models: readonly RoutedModel[];
  defaultModelId: string;
  utilityModelId: string;
}

let warnedInvalid = false;

/**
 * The env's platform provider: the catalog's provider until the admin saves
 * one in /admin. An invalid value falls back to the default, once logged.
 */
export function platformProviderId(): PlatformProviderId {
  // Read as a literal so Next inlines it into the client bundle.
  const value = process.env.NEXT_PUBLIC_AI_PROVIDER?.trim().toLowerCase();
  if (!value) return DEFAULT_PLATFORM_PROVIDER;
  if ((PLATFORM_PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as PlatformProviderId;
  }
  if (!warnedInvalid) {
    warnedInvalid = true;
    console.warn(
      `[ai-provider] NEXT_PUBLIC_AI_PROVIDER="${value}" is not one of ` +
        `${PLATFORM_PROVIDER_IDS.join(", ")}. Using ${DEFAULT_PLATFORM_PROVIDER}.`,
    );
  }
  return DEFAULT_PLATFORM_PROVIDER;
}

/**
 * The env provider's curated catalog, used until the admin saves one: every
 * model routed to that provider and offered to everyone, its title model as
 * the utility model (hidden when users can't pick it, as on OpenRouter).
 */
export function envCatalog(provider: PlatformProviderId): RoutedCatalog {
  const { label, models, defaultModel, titleModel } = AI_PROVIDERS[provider];
  const route = (model: ProviderModel, hidden: boolean): RoutedModel => ({
    id: model.id,
    name: model.label,
    vendor: model.vendor ?? label,
    vision: model.vision === true,
    provider,
    providerModelId: model.id,
    access: "everyone",
    hidden,
  });
  // Every platform provider has a curated default and title model.
  const utilityModelId = titleModel!;
  const utility = models.some((model) => model.id === utilityModelId)
    ? []
    : [route({ id: utilityModelId, label: utilityModelId }, true)];
  return {
    models: [...models.map((model) => route(model, false)), ...utility],
    defaultModelId: defaultModel!,
    utilityModelId,
  };
}

/**
 * The catalog model a platform choice runs: the requested one if offered,
 * else the default, else the first model offered. Hidden models are never
 * offered, so an unknown, removed or hidden id runs the default and a crafted
 * request can't pick its model. Pickers pass the models the user may pick;
 * the server passes the whole catalog and checks promo access after.
 */
export function resolveCatalogModel<M extends { id: string; hidden?: boolean }>(
  catalog: { models: readonly M[]; defaultModelId: string },
  requestedId: string | undefined,
): M {
  const offered = catalog.models.filter((model) => !model.hidden);
  const find = (id: string | undefined) => offered.find((model) => model.id === id);
  // Never empty: a saved catalog's default is offered, and curated catalogs list several.
  return find(requestedId) ?? find(catalog.defaultModelId) ?? offered[0]!;
}

/**
 * The model for chat titles and editor AI: the catalog's utility model, which
 * may be hidden from users, else the default.
 */
export const utilityModel = (catalog: RoutedCatalog): RoutedModel =>
  catalog.models.find((model) => model.id === catalog.utilityModelId) ??
  resolveCatalogModel(catalog, undefined);
