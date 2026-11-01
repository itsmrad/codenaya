import ky, { HTTPError } from "ky";
import { useMutation, useQuery } from "convex/react";

import { opusRunsLeft } from "@/features/promotions/github-promo";
import { usePromoActive, usePromoClaim } from "@/features/promotions/hooks/use-promo";

import { type PromoStanding, type PublicCatalogModel, pickableModels } from "../catalog";
import { envCatalog, platformProviderId } from "../platform";
import type { AiProviderId } from "../registry";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Bindings for the AI providers settings tab. Keys are listed and deleted in
 * Convex, but created and tested through `/api/ai-providers`, which holds the
 * KEK and talks to the provider. Nothing here ever receives key material.
 */

/** The signed-in user's keys, newest first, as browser-safe summaries. */
export const useAiProviderKeys = () => useQuery(api.aiProviders.list);

/** The platform models the user may pick now, and the platform default. */
export interface PlatformModels {
  models: PublicCatalogModel[];
  defaultModelId: string;
  /** The claim's counted promo runs left, for the picker's tags. */
  countedRunsLeft: number;
}

/**
 * The catalog users pick from: the admin's in /admin, live (a removed model
 * leaves open pickers at once), else the env provider's. Never routes or
 * prices. Undefined while loading.
 */
const usePlatformCatalog = () => {
  const saved = useQuery(api.platformCatalog.getForUsers);
  return saved === undefined ? undefined : (saved ?? envCatalog(platformProviderId()));
};

/** The caller's promo standing (ADR 0009). Undefined while the claim loads. */
const usePromoStanding = (): PromoStanding | undefined => {
  const claim = usePromoClaim();
  const active = usePromoActive();
  if (claim === undefined) return undefined;
  return { claimed: claim !== null, active, countedRunsLeft: claim ? opusRunsLeft(claim) : 0 };
};

const NO_PROMO: PromoStanding = { claimed: false, active: false, countedRunsLeft: 0 };

const platformModels = (
  catalog: { models: readonly (PublicCatalogModel & { hidden?: boolean })[]; defaultModelId: string },
  promo: PromoStanding,
): PlatformModels => ({
  models: pickableModels(catalog.models, promo),
  defaultModelId: catalog.defaultModelId,
  countedRunsLeft: promo.countedRunsLeft,
});

/**
 * The models the user may pick (ADR 0010): everyone's, plus promo models only
 * with a claim, while the promotion runs, and counted ones only while runs are
 * left, so a stored Opus choice falls back instead of being refused on every
 * send. Undefined while the catalog or the claim is loading.
 */
export const usePlatformModels = (): PlatformModels | undefined => {
  const catalog = usePlatformCatalog();
  const promo = usePromoStanding();
  return catalog && promo && platformModels(catalog, promo);
};

/**
 * `usePlatformModels` for pickers: the env provider's catalog until the
 * catalog loads, and no promo models until the claim does.
 */
export const usePlatformModelsOrCatalog = (): PlatformModels =>
  platformModels(
    usePlatformCatalog() ?? envCatalog(platformProviderId()),
    usePromoStanding() ?? NO_PROMO,
  );

export const useRemoveAiProviderKey = () => useMutation(api.aiProviders.remove);

/** The default model; no `defaultKeyId` means the Codenaya platform key. */
export const useAiPreferences = () => useQuery(api.aiProviders.getPreferences);

export const useSetAiPreferences = () =>
  useMutation(api.aiProviders.setPreferences);

export interface AddAiProviderKeyInput {
  provider: AiProviderId;
  apiKey: string;
  label?: string;
  baseUrl?: string;
  modelIds?: string[];
}

/** Tests the key with the provider, then stores it sealed. */
export const addAiProviderKey = (input: AddAiProviderKeyInput) =>
  ky.post("/api/ai-providers", { json: input, timeout: 30_000 }).json();

/** Re-tests a stored key; the route records the outcome on the key. */
export const testAiProviderKey = (keyId: Id<"aiProviderKeys">) =>
  ky.post(`/api/ai-providers/${keyId}/test`, { timeout: 30_000 }).json();

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

/**
 * The message to show for a failed `/api/ai-providers` call. The routes write
 * errors for users (rejected key, unsafe URL, rate limit) and never echo the
 * key, so their text is shown as is.
 */
export const aiProviderRequestError = async (error: unknown) => {
  if (error instanceof HTTPError) {
    const body = await error.response
      .json<{ error?: string }>()
      .catch(() => ({ error: undefined }));
    return body.error ?? FALLBACK_MESSAGE;
  }
  return FALLBACK_MESSAGE;
};
