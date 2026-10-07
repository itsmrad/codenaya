import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL_ID,
} from "../conversations/agent-models";

/**
 * Model providers a user can bring their own key for (BYOK), plus the
 * Codenaya platform provider (our OpenRouter key).
 *
 * Client-safe and free of path aliases so the settings UI, the Next.js routes
 * and Convex functions can all import it.
 *
 * Model ids are each provider's own form: OpenRouter's namespaced
 * `provider/model`, bare ids for OpenAI and Anthropic. Custom endpoints have no
 * curated list; the user enters the ids their endpoint serves.
 */

export const AI_PROVIDER_IDS = [
  "openrouter",
  "openai",
  "anthropic",
  "custom",
] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface ProviderModel {
  id: string;
  label: string;
}

export interface AiProviderMeta {
  id: AiProviderId;
  label: string;
  /** Fixed API base URL. Custom endpoints supply their own. */
  baseUrl?: string;
  /** Curated models. Empty for custom, whose models are user-entered. */
  models: readonly ProviderModel[];
  /** Small, cheap model for conversation titles. Custom uses its first model. */
  titleModel?: string;
}

/** Limits on user-entered model ids for a custom endpoint. */
export const MAX_CUSTOM_MODEL_IDS = 20;
export const MAX_MODEL_ID_LENGTH = 200;

export const AI_PROVIDERS: Record<AiProviderId, AiProviderMeta> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: AGENT_MODELS.map(({ id, label }) => ({ id, label })),
    titleModel: "openai/gpt-5.4-mini",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    ],
    titleModel: "gpt-5.4-mini",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
    titleModel: "claude-haiku-4-5",
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    models: [],
  },
};

/** The platform provider, used when the user has no default key. */
export const PLATFORM_PROVIDER = {
  id: "codenaya",
  label: "Codenaya",
  models: AI_PROVIDERS.openrouter.models,
  defaultModelId: DEFAULT_AGENT_MODEL_ID,
  titleModel: AI_PROVIDERS.openrouter.titleModel!,
} as const;

export function isAiProviderId(value: unknown): value is AiProviderId {
  return AI_PROVIDER_IDS.includes(value as AiProviderId);
}

/**
 * Model ids usable with a stored key: the curated list, or the user-entered
 * ids for a custom endpoint.
 */
export function modelIdsFor(key: {
  provider: AiProviderId;
  modelIds?: readonly string[];
}): readonly string[] {
  return key.provider === "custom"
    ? (key.modelIds ?? [])
    : AI_PROVIDERS[key.provider].models.map((model) => model.id);
}

/** The model for conversation titles on a key's provider. */
export function titleModelFor(key: {
  provider: AiProviderId;
  modelIds?: readonly string[];
}): string | undefined {
  return AI_PROVIDERS[key.provider].titleModel ?? key.modelIds?.[0];
}

/**
 * API base URL for a key: the provider's fixed one, or the endpoint stored on
 * a custom key.
 */
export function baseUrlFor(key: {
  provider: AiProviderId;
  baseUrl?: string;
}): string {
  const baseUrl = AI_PROVIDERS[key.provider].baseUrl ?? key.baseUrl;
  if (!baseUrl) {
    throw new Error(`A base URL is required for a ${key.provider} key.`);
  }
  return baseUrl;
}
