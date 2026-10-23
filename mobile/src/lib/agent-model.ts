import { useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import {
  AI_PROVIDERS,
  type ActivePlatform,
  type AgentModelChoice,
  PLATFORM_PROVIDER,
  keyModels,
  modelAcceptsImages,
  modelIdsFor,
  platformConfigFrom,
  platformModels,
  platformProviderId,
  resolvePlatformModel,
  runModelLabel,
} from "@/lib/shared";

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
  const active = useQuery(api.platformModels.getActive, { fallbackProvider: platformProviderId() });
  const platform: ActivePlatform = active
    ? { provider: active.provider, config: platformConfigFrom(active.config) }
    : { provider: platformProviderId(), config: null };

  const isAvailable = (choice: AgentModelChoice) => {
    if (!choice.keyId) {
      return !active || platformModels(platform.provider, platform.config).some((m) => m.id === choice.modelId);
    }
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
    ) ?? { modelId: resolvePlatformModel(platform.provider, platform.config, undefined).id };

  const key = model.keyId ? keys?.find((k) => k._id === model.keyId) : undefined;
  const platformModel = resolvePlatformModel(platform.provider, platform.config, model.modelId);
  const label = key ? runModelLabel(model.modelId, key) : runModelLabel(platformModel);
  // Sending images to a model without vision is refused, as on the web.
  const acceptsImages = key ? modelAcceptsImages(model.modelId, key) : platformModel.vision === true;
  // Models the picker offers: the platform's, then one group per usable key.
  const groups = [
    { title: PLATFORM_PROVIDER.label, keyId: undefined, models: platformModels(platform.provider, platform.config) },
    ...(keys ?? [])
      .filter((k) => k.status === "active" || k._id === model.keyId)
      .map((k) => ({ title: `${AI_PROVIDERS[k.provider].label} · ${k.label}${k.status === "invalid" ? " (invalid)" : ""}`, keyId: k._id, models: keyModels(k) })),
  ];

  return { model, setModel: setStored, label, acceptsImages, groups };
};
