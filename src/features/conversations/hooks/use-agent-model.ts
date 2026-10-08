import { useSyncExternalStore } from "react";

import { modelIdsFor } from "@/features/ai-providers/registry";
import {
  useAiPreferences,
  useAiProviderKeys,
} from "@/features/ai-providers/hooks/use-ai-providers";
import type { AiProviderKeySummary } from "../../../../convex/aiProviders";

import {
  type AgentModelChoice,
  DEFAULT_AGENT_MODEL_ID,
  isAgentModelId,
} from "../agent-models";

const STORAGE_KEY = "codenaya:agent-model";

// In-memory copy so the choice still sticks for the session when storage is
// unavailable (private mode, blocked site data). `undefined` means "not read
// yet"; `null` means nothing was picked in this browser.
let currentModel: AgentModelChoice | null | undefined;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

/** Stored as JSON `{ keyId?, modelId }`; older builds stored a bare platform id. */
function parseStored(raw: string | null): AgentModelChoice | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as AgentModelChoice).modelId === "string"
    ) {
      const { keyId, modelId } = parsed as AgentModelChoice;
      return typeof keyId === "string" ? { keyId, modelId } : { modelId };
    }
    return null;
  } catch {
    return { modelId: raw };
  }
}

function readModel(): AgentModelChoice | null {
  if (currentModel === undefined) {
    try {
      currentModel = parseStored(localStorage.getItem(STORAGE_KEY));
    } catch {
      currentModel = null;
    }
  }
  return currentModel;
}

function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY) {
    currentModel = undefined;
    notify();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function setModel(model: AgentModelChoice) {
  currentModel = model;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
  } catch {
    // Storage unavailable: the in-memory value still applies for this session.
  }
  notify();
}

/**
 * Whether a choice can still be sent: a platform model on the allowlist, or a
 * model of one of the user's keys. While keys are loading a BYOK choice is
 * kept; the server validates it either way.
 */
function isAvailable(
  choice: AgentModelChoice,
  keys: AiProviderKeySummary[] | undefined,
) {
  if (!choice.keyId) return isAgentModelId(choice.modelId);
  if (!keys) return true;
  const key = keys.find((k) => k._id === choice.keyId);
  return Boolean(key && modelIdsFor(key).includes(choice.modelId));
}

/**
 * The agent model for the next run: the one picked in this browser (persisted
 * to localStorage), else the user's default from Settings → AI providers, else
 * the platform default. A pick whose key was deleted falls through.
 */
export function useAgentModel() {
  const stored = useSyncExternalStore(
    subscribe,
    readModel,
    // Server render has no storage; the client re-renders with the saved value.
    () => null,
  );
  const keys = useAiProviderKeys();
  const preferences = useAiPreferences();

  const preferred: AgentModelChoice | null = preferences
    ? {
        ...(preferences.defaultKeyId ? { keyId: preferences.defaultKeyId } : {}),
        modelId: preferences.defaultModelId,
      }
    : null;

  const model =
    [stored, preferred].find(
      (choice): choice is AgentModelChoice =>
        choice !== null && isAvailable(choice, keys),
    ) ?? { modelId: DEFAULT_AGENT_MODEL_ID };

  return [model, setModel] as const;
}
