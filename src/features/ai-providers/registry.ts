import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL_ID,
} from "../conversations/agent-models";

/**
 * Model providers a user can bring their own key for (BYOK). The Codenaya
 * platform routes each of its models to one of them (`platform.ts`).
 *
 * Client-safe and free of path aliases so the settings UI, the Next.js routes
 * and Convex functions can all import it.
 *
 * Model ids are each provider's own form: OpenRouter's namespaced
 * `provider/model`, bare ids for OpenAI and Anthropic, Groq's own ids. Custom endpoints have no
 * curated list; the user enters the ids their endpoint serves.
 */

export const AI_PROVIDER_IDS = [
  "openrouter",
  "openai",
  "anthropic",
  "groq",
  "custom",
] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface ProviderModel {
  id: string;
  label: string;
  /** Who made the model, shown next to it when it differs from the provider. */
  vendor?: string;
  /** Accepts image input, so attached images can be sent to it. */
  vision?: boolean;
}

export interface AiProviderMeta {
  id: AiProviderId;
  label: string;
  /** Fixed API base URL. Custom endpoints supply their own. */
  baseUrl?: string;
  /** Curated models. Empty for custom, whose models are user-entered. */
  models: readonly ProviderModel[];
  /** The platform's model when none (or an unlisted one) is picked. */
  defaultModel?: string;
  /** Small, cheap model for conversation titles. Custom uses its first model. */
  titleModel?: string;
  /** `false` omits `parallel_tool_calls`, for an OpenAI-format endpoint that rejects it. On when unset. */
  parallelToolCalls?: boolean;
}

/** Limits on user-entered model ids for a custom endpoint. */
export const MAX_CUSTOM_MODEL_IDS = 20;
export const MAX_MODEL_ID_LENGTH = 200;

export const AI_PROVIDERS: Record<AiProviderId, AiProviderMeta> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: AGENT_MODELS.map(({ id, label, provider, vision }) => ({
      id,
      label,
      vendor: provider,
      vision,
    })),
    defaultModel: DEFAULT_AGENT_MODEL_ID,
    titleModel: "anthropic/claude-haiku-5.5",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", vision: true },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", vision: true },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", vision: true },
      { id: "gpt-6-luna", label: "GPT-6 Luna", vision: true },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", vision: true },
    ],
    defaultModel: "gpt-5.6-luna",
    titleModel: "gpt-6-luna",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    // No `vision`: Claude reads images, but AgentKit's Anthropic adapter only
    // forwards text content, so attached images could not reach it.
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
    defaultModel: "claude-sonnet-5-5",
    titleModel: "claude-haiku-5-5",
  },
  groq: {
    id: "groq",
    label: "Groq",
    // OpenAI-compatible Chat Completions.
    baseUrl: "https://api.groq.com/openai/v1",
    // Tool-calling models from `GET /openai/v1/models`; none take images.
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", vendor: "OpenAI" },
      { id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B", vendor: "Qwen" },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", vendor: "OpenAI" },
    ],
    defaultModel: "openai/gpt-oss-120b",
    titleModel: "openai/gpt-oss-20b",
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    models: [],
  },
};

/** The platform, used when the user has no default key. Its models are in `platform.ts`. */
export const PLATFORM_PROVIDER = { label: "Codenaya" } as const;

/**
 * `code` on an editor AI route error caused by the user's own key, so the
 * editor can point to the settings page.
 */
export const PROVIDER_KEY_ERROR_CODE = "provider_key";

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

/** A key's models, labelled from the registry; custom ids label themselves. */
export function keyModels(key: {
  provider: AiProviderId;
  modelIds?: readonly string[];
}): readonly ProviderModel[] {
  return key.provider === "custom"
    ? (key.modelIds ?? []).map((id) => ({ id, label: id }))
    : AI_PROVIDERS[key.provider].models;
}

/**
 * Whether a model on a key can be sent attached images, from the key's curated
 * list. A custom endpoint's models cannot be looked up, so they are trusted;
 * the endpoint reports it if it can't. Platform models carry `vision` themselves.
 */
export function modelAcceptsImages(
  modelId: string,
  key: { provider: AiProviderId },
): boolean {
  if (key.provider === "custom") return true;
  return AI_PROVIDERS[key.provider].models.find((model) => model.id === modelId)?.vision === true;
}

/** The key fields a picker shows; all are in the browser-safe key summary. */
interface PickerKey {
  _id: string;
  provider: AiProviderId;
  label: string;
  baseUrl?: string;
  modelIds?: readonly string[];
  maskedPreview: string;
  fingerprint?: string;
  status: "active" | "invalid";
}

/**
 * A key's name in pickers: its label, or "Your key ••••3f2a" when the label
 * only repeats the provider name (the default label), so the group never reads
 * "Anthropic · Anthropic" and its models never look like the platform's (#600).
 */
export function keyDisplayName(key: Pick<PickerKey, "provider" | "label" | "maskedPreview">): string {
  const label = key.label.trim();
  return !label || label.toLowerCase() === AI_PROVIDERS[key.provider].label.toLowerCase()
    ? `Your key ${key.maskedPreview}`
    : label;
}

/** A key's group heading in pickers: "Anthropic · Work", flagged when invalid. */
export function keyGroupLabel(key: Pick<PickerKey, "provider" | "label" | "maskedPreview" | "status">): string {
  const invalid = key.status === "invalid" ? " (invalid)" : "";
  return `${AI_PROVIDERS[key.provider].label} · ${keyDisplayName(key)}${invalid}`;
}

/**
 * The keys a picker lists, one group each: active keys, plus the selected key
 * even if since marked invalid. A key that repeats another's whole route
 * (provider, endpoint, label, secret, models) is the same key added twice, so
 * it is listed once, keeping the selected one. Keys that differ in any of
 * those are distinct routes and all stay. The secret is compared by
 * fingerprint when both keys have one, else by masked preview (#614).
 */
export function pickerKeys<K extends PickerKey>(keys: readonly K[], selectedKeyId?: string): K[] {
  const route = (key: K) =>
    JSON.stringify([key.provider, key.baseUrl ?? "", key.label.trim(), modelIdsFor(key)]);
  const sameKey = (a: K, b: K) =>
    route(a) === route(b) &&
    (a.fingerprint && b.fingerprint ? a.fingerprint === b.fingerprint : a.maskedPreview === b.maskedPreview);
  const shown = keys.filter((key) => key.status === "active" || key._id === selectedKeyId);
  const selected = shown.find((key) => key._id === selectedKeyId);
  const kept: K[] = selected ? [selected] : [];
  return shown.filter((key) => {
    if (key === selected) return true;
    if (kept.some((other) => sameKey(other, key))) return false;
    kept.push(key);
    return true;
  });
}

/**
 * Short "provider · model" label for a run, shown on the chat's run block.
 * Without a key it names the platform (pass its resolved model); a custom
 * endpoint is named by its label.
 */
export function runModelLabel(
  model: ProviderModel | string,
  key?: { provider: AiProviderId; label: string; modelIds?: readonly string[] },
): string {
  const modelLabel =
    typeof model !== "string"
      ? model.label
      : ((key && keyModels(key).find((m) => m.id === model)?.label) ?? model);
  const provider = !key
    ? PLATFORM_PROVIDER.label
    : key.provider === "custom"
      ? key.label
      : AI_PROVIDERS[key.provider].label;
  return `${provider} · ${modelLabel}`;
}
