import { useAuth } from "@clerk/expo";
import { useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";

import { api } from "@/lib/api";
import {
  AI_PROVIDERS,
  type AgentModelChoice,
  type CatalogModel,
  PLATFORM_PROVIDER,
  type ProviderModel,
  envCatalog,
  keyModels,
  modelAcceptsImages,
  modelIdsFor,
  pickableModels,
  platformProviderId,
  resolveCatalogModel,
  runModelLabel,
} from "@/lib/shared";

type PickerCatalog = {
  models: readonly (Pick<CatalogModel, "id" | "name" | "vendor" | "vision" | "access"> & { hidden?: boolean })[];
  defaultModelId: string;
};

// Per user, so another account signed in on this device starts from its own default.
// The old device-wide key ("codenaya.agent-model") is ignored.
const storageKey = (userId: string) => `codenaya.agent-model.${userId}`;

// Shared across screens for the session; persisted so the pick survives restarts.
let stored: { userId: string; choice: AgentModelChoice | null } | undefined;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setStored = (userId: string, choice: AgentModelChoice | null) => {
  stored = { userId, choice };
  notify();
};

/**
 * The agent model for the next run, like the web's useAgentModel: the one
 * picked on this device, else the user's default from Settings, else the
 * platform default. A pick whose key or model is gone falls through.
 */
export const useAgentModel = () => {
  // Read as an external store, so a pick re-renders every screen using it.
  // (A module variable read in render is invisible to the React Compiler's
  // memoization: the chat kept showing the default model after a pick.)
  const { userId } = useAuth();
  const current = useSyncExternalStore(subscribe, () => stored);
  const picked = current && current.userId === userId ? current.choice : null;
  useEffect(() => {
    if (!userId || stored?.userId === userId) return;
    SecureStore.getItemAsync(storageKey(userId))
      .then((raw) => setStored(userId, raw ? (JSON.parse(raw) as AgentModelChoice) : null))
      .catch(() => setStored(userId, null));
  }, [userId]);
  const setModel = (choice: AgentModelChoice) => {
    if (!userId) return;
    setStored(userId, choice);
    SecureStore.setItemAsync(storageKey(userId), JSON.stringify(choice)).catch(() => undefined);
  };

  const keys = useQuery(api.aiProviders.list);
  const preferences = useQuery(api.aiProviders.getPreferences);
  // The models the user may pick (ADR 0010), as the web's usePlatformModels:
  // the admin's catalog else the env provider's, everyone's models only now
  // that the GitHub promotion has ended (ADR 0009). A saved promo pick falls
  // back to the default through isAvailable below.
  const saved = useQuery(api.platformCatalog.getForUsers);
  const catalog: PickerCatalog = saved ?? envCatalog(platformProviderId());
  const platformModels: ProviderModel[] = pickableModels(catalog.models).map((m) => ({
    id: m.id,
    label: m.name,
    vendor: m.vendor,
    vision: m.vision,
  }));
  const platformLoaded = saved !== undefined;
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
    [picked, preferred].find(
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

  return { model, setModel, label, acceptsImages, groups };
};
