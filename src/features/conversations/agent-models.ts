/**
 * The curated OpenRouter catalog: the models users can pick when the platform
 * runs on OpenRouter (`ai-providers/platform.ts`), and the models of an
 * OpenRouter BYOK key. Kept free of server-only imports so the client bundle
 * can use it.
 *
 * Every id is an OpenRouter model id that advertises `tools` in
 * `supported_parameters` on `GET https://openrouter.ai/api/v1/models` — the
 * agent depends on multi-step tool calling, so a model without it is useless here.
 *
 * `vision` mirrors `image` in the model's `architecture.input_modalities` on
 * the same endpoint: whether the agent can be sent attached images.
 *
 * The server treats the platform list as an allowlist: any other id is replaced
 * with the default, so a crafted request cannot route runs to arbitrary models.
 */
export const AGENT_MODELS = [
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "OpenAI", vision: true },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "OpenAI", vision: true },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", provider: "OpenAI", vision: true },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", provider: "Anthropic", vision: true },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", provider: "Anthropic", vision: true },
  { id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1", provider: "Anthropic", vision: true },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "Google", vision: true },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "Google", vision: true },
  { id: "x-ai/grok-4.7", label: "Grok 4.7", provider: "xAI", vision: true },
  { id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", provider: "DeepSeek", vision: false },
  { id: "qwen/qwen3.8-max-0902", label: "Qwen3.8 Max", provider: "Qwen", vision: true },
  { id: "mistralai/mistral-large-4-0", label: "Mistral Large 4", provider: "Mistral", vision: true },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", provider: "Moonshot AI", vision: true },
  { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "Z.ai", vision: false },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", provider: "Meta", vision: true },
] as const;

export type AgentModel = (typeof AGENT_MODELS)[number];
export type AgentModelId = AgentModel["id"];

/** The OpenRouter model used when the user has not picked one. */
export const DEFAULT_AGENT_MODEL_ID: AgentModelId = "openai/gpt-5.6-luna";

/**
 * What a run uses: a platform model (no `keyId`), or a model on one of the
 * user's own provider keys (BYOK). Sent by the chat UI, validated by the API
 * route and again by the agent run.
 */
export interface AgentModelChoice {
  keyId?: string;
  modelId: string;
}

const SONNET: AgentModelId = "anthropic/claude-sonnet-5.5";
const TO_SONNET = { id: SONNET, usdPerMTok: [2, 10] } as const;

/**
 * "Retry with another model" on a stuck run (#306) steps one tier up: a
 * sideways or cheaper switch usually repeats the loop. Each entry is the next
 * model with its OpenRouter list price (USD per 1M tokens in, out; 2026-10-14);
 * null means the strongest of its vendor. Other catalog models step up to Sonnet.
 * Prices are hand-kept because the catalog's prices are deliberately not sent
 * to the browser (`platformCatalog.getForUsers`).
 * shortcut: a hand-kept ladder and prices; replace with the `tier` field (#321)
 * and a server-side cost estimate once those land.
 */
const NEXT_TIER: Record<string, { id: AgentModelId; usdPerMTok: readonly [number, number] } | null> = {
  "anthropic/claude-haiku-5.5": TO_SONNET,
  [SONNET]: { id: "anthropic/claude-opus-5.5", usdPerMTok: [4, 20] },
  "openai/gpt-6-luna": { id: "openai/gpt-6.1-sol", usdPerMTok: [2, 10] },
  "google/gemini-3.8-flash": { id: "google/gemini-3.1-pro-preview", usdPerMTok: [2, 12] },
  "anthropic/claude-opus-5.5": null,
  "anthropic/claude-fable-5.1": null,
  "openai/gpt-6.1-sol": null,
  "google/gemini-3.1-pro-preview": null,
};

/** A typical error-fix run: about 6 model calls, ~108k tokens in and ~8k out. */
const FIX_RUN_MTOK = { input: 0.108, output: 0.008 };

/**
 * The model to retry a stuck run on, with a rough cost range for the retry
 * (caching or a shorter run roughly halves it). Null on a top-tier model or
 * an id outside the catalog.
 */
const stepUp = (modelId: string) => {
  if (Object.hasOwn(NEXT_TIER, modelId)) return NEXT_TIER[modelId];
  return AGENT_MODELS.some((model) => model.id === modelId) ? TO_SONNET : null;
};

export const nextTier = (modelId: string) => {
  const next = stepUp(modelId);
  if (!next) return null;
  const [input, output] = next.usdPerMTok;
  const usd = FIX_RUN_MTOK.input * input + FIX_RUN_MTOK.output * output;
  return {
    id: next.id,
    label: AGENT_MODELS.find((model) => model.id === next.id)?.label ?? next.id,
    costUsd: [usd / 2, usd] as const,
  };
};
