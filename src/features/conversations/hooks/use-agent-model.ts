import { useSyncExternalStore } from "react";

import {
  type AgentModelId,
  DEFAULT_AGENT_MODEL_ID,
  resolveAgentModelId,
} from "../agent-models";

const STORAGE_KEY = "codenaya:agent-model";

// In-memory copy so the choice still sticks for the session when storage is
// unavailable (private mode, blocked site data). `null` means "not read yet".
let currentModel: AgentModelId | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function readModel(): AgentModelId {
  if (currentModel === null) {
    try {
      currentModel = resolveAgentModelId(localStorage.getItem(STORAGE_KEY));
    } catch {
      currentModel = DEFAULT_AGENT_MODEL_ID;
    }
  }
  return currentModel;
}

function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY) {
    currentModel = null;
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

function setModel(model: AgentModelId) {
  currentModel = model;
  try {
    localStorage.setItem(STORAGE_KEY, model);
  } catch {
    // Storage unavailable: the in-memory value still applies for this session.
  }
  notify();
}

/** The agent model chosen in this browser, persisted to localStorage. */
export function useAgentModel() {
  const model = useSyncExternalStore(
    subscribe,
    readModel,
    // Server render has no storage; the client re-renders with the saved value.
    () => DEFAULT_AGENT_MODEL_ID,
  );

  return [model, setModel] as const;
}
