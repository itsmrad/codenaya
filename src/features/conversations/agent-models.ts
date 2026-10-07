/**
 * Models the user can pick for the coding agent, shared by the chat UI and the
 * server. Kept free of server-only imports so the client bundle can use it.
 *
 * Every id is an OpenRouter model id that advertises `tools` in
 * `supported_parameters` on `GET https://openrouter.ai/api/v1/models` — the
 * agent depends on multi-step tool calling, so a model without it is useless here.
 *
 * The server treats this list as an allowlist: any other id is replaced with
 * the default, so a crafted request cannot route runs to arbitrary models.
 */
export const AGENT_MODELS = [
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "OpenAI" },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "OpenAI" },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", provider: "OpenAI" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", provider: "Anthropic" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", provider: "Anthropic" },
  { id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1", provider: "Anthropic" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "Google" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "Google" },
  { id: "x-ai/grok-4.7", label: "Grok 4.7", provider: "xAI" },
  { id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", provider: "DeepSeek" },
  { id: "qwen/qwen3.8-max-0902", label: "Qwen3.8 Max", provider: "Qwen" },
  { id: "mistralai/mistral-large-4-0", label: "Mistral Large 4", provider: "Mistral" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", provider: "Moonshot AI" },
  { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "Z.ai" },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", provider: "Meta" },
] as const;

export type AgentModel = (typeof AGENT_MODELS)[number];
export type AgentModelId = AgentModel["id"];

/** The model used when the user has not picked one. */
export const DEFAULT_AGENT_MODEL_ID: AgentModelId = "openai/gpt-5.6-luna";

export function isAgentModelId(value: unknown): value is AgentModelId {
  return AGENT_MODELS.some((model) => model.id === value);
}

/** Returns `value` when it is an allowlisted model id, otherwise the default. */
export function resolveAgentModelId(value: unknown): AgentModelId {
  return isAgentModelId(value) ? value : DEFAULT_AGENT_MODEL_ID;
}
