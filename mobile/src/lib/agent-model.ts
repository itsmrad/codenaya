import { useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import {
  AI_PROVIDERS,
  type AgentModelChoice,
  type CatalogModel,
  PLATFORM_PROVIDER,
  type ProviderModel,
  envCatalog,
  isPromoActive,
  keyModels,
  modelAcceptsImages,
  modelIdsFor,
  opusRunsLeft,
  pickableModels,
  platformProviderId,
  resolveCatalogModel,
  runModelLabel,
} from "@/lib/shared";

type PickerCatalog = {
  models: readonly (Pick<CatalogModel, "id" | "name" | "vendor" | "vision" | "access"> & { hidden?: boolean })[];
  defaultModelId: string;
};

const STORAGE_KEY = "codenaya.agent-model";

// Shared across screens for the session; persisted so the pick survives restarts.
let stored: AgentModelChoice | null | undefined;
const listeners = new Set<() => void>();

const setStored = (choice: AgentModelChoice) => {
  stored = choice;
  listeners.forEach((listener) => listener());
  SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(choice)).catch(() => undefined);
};

/**
 * The agent model for the next run, like the web's useAgentModel: the one
 * picked on this device, else the user's default from Settings, else the
 * platform default. A pick whose key or model is gone falls through.
 */
export const useAgentModel = () => {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    if (stored === undefined) {
      SecureStore.getItemAsync(STORAGE_KEY)
        .then((raw) => {
          stored = raw ? (JSON.parse(raw) as AgentModelChoice) : null;
        })
        .catch(() => {
          stored = null;
        })
        .finally(listener);
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const keys = useQuery(api.aiProviders.list);
  const preferences = useQuery(api.aiProviders.getPreferences);
  // The models the user may pick (ADR 0010), as the web's usePlatformModels:
  // the admin's catalog else the env provider's, promo models only with a claim.
  const saved = useQuery(api.platformCatalog.getForUsers);
  const claim = useQuery(api.promoClaims.getMine);
  const catalog: PickerCatalog = saved ?? envCatalog(platformProviderId());
  const promo = { claimed: Boolean(claim), active: isPromoActive(Date.now()), countedRunsLeft: claim ? opusRunsLeft(claim) : 0 };
  const platformModels: ProviderModel[] = pickableModels(catalog.models, promo).map((m) => ({
    id: m.id,
    label: m.name,
    vendor: m.vendor,
    vision: m.vision,
  }));
  const platformLoaded = saved !== undefined && claim !== undefined;
  const platformCatalog = { models: platformModels, defaultModelId: catalog.defaultModelId };

  const isAvailable = (choice: AgentModelChoice) => {
    if (!choice.keyId) return !platformLoaded || platformModels.some((m) => m.id === choice.modelId);
    if (!keys) return true;
    const key = keys.find((k) => k._id === choice.keyId);
    return Boolean(key && modelIdsFor(key).includes(choice.modelId));
  };

  const preferred: AgentModelChoice | null = preferences
    ? { ...(preferences.defaultKeyId ? { keyId: preferences.defaultKeyId } : {}), modelId: preferences.defaultModelId }
    : null;
  const model =
    [stored ?? null, preferred].find(
      (choice): choice is AgentModelChoice => choice !== null && isAvailable(choice),
    ) ?? { modelId: resolveCatalogModel(platformCatalog, undefined).id };

  const key = model.keyId ? keys?.find((k) => k._id === model.keyId) : undefined;
  const platformModel = resolveCatalogModel(platformCatalog, model.modelId);
  const label = key ? runModelLabel(model.modelId, key) : runModelLabel(platformModel);
  // Sending images to a model without vision is refused, as on the web.
  const acceptsImages = key ? modelAcceptsImages(model.modelId, key) : platformModel.vision === true;
  // Models the picker offers: the platform's, then one group per usable key.
  const groups = [
    { title: PLATFORM_PROVIDER.label, keyId: undefined, models: platformModels },
    ...(keys ?? [])
      .filter((k) => k.status === "active" || k._id === model.keyId)
      .map((k) => ({ title: `${AI_PROVIDERS[k.provider].label} · ${k.label}${k.status === "invalid" ? " (invalid)" : ""}`, keyId: k._id, models: keyModels(k) })),
  ];

  return { model, setModel: setStored, label, acceptsImages, groups };
};
