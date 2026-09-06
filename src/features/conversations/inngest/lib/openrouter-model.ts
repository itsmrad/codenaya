import { openai } from "@inngest/agent-kit";

/**
 * OpenRouter models for the Inngest agent.
 *
 * OpenRouter exposes an OpenAI-compatible Chat Completions API, so AgentKit's
 * `openai()` adapter works unchanged — only `baseUrl` and `apiKey` differ. That
 * keeps tool calling, streaming and message formatting on the path AgentKit
 * already supports, rather than needing a new adapter.
 *
 * ## Why route through OpenRouter at all
 *
 * One key reaches every provider's models, so the model can be changed without
 * provisioning new credentials. Useful while verifying the integration end to end.
 *
 * ## Configuration resolved lazily
 *
 * `readApiKey()` is called at request time, not module load. An earlier version of
 * `workflow/lib/vertex-model.ts` validated env vars during module evaluation, which
 * made merely *importing* it fatal when credentials were absent and broke
 * `next build` during page-data collection. Same mistake is avoided here.
 */

/**
 * Model ids are OpenRouter's namespaced form (`provider/model`), not bare OpenAI
 * names. Verified against `GET https://openrouter.ai/api/v1/models`.
 */
export const OPENROUTER_MODELS = {
  /**
   * Coding agent. Handles the file tools and any connected MCP tools, so it needs
   * reliable multi-step tool calling.
   */
  coding: "openai/gpt-5.6-luna" as const,

  /**
   * Conversation title generator. A short deterministic generation — a small, cheap
   * model is the right fit and a frontier model would be waste.
   */
  title: "openai/gpt-5.4-mini" as const,
} as const;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function readApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    // Thrown inside a step, so Inngest surfaces it against the run rather than
    // crashing the process, and the message names the variable to set.
    throw new Error(
      "OPENROUTER_API_KEY is not configured. Add it to .env.local and to the " +
        "deployment environment.",
    );
  }

  return apiKey;
}

/**
 * Build an OpenRouter-backed model for the AgentKit agent.
 *
 * @param model An OpenRouter model id, e.g. `openai/gpt-5.6-luna`.
 * @param temperature Omitted for models that reject it — some reasoning models
 * error on a non-default temperature rather than ignoring it.
 */
export function openRouterModel(model: string, temperature?: number) {
  return openai({
    model,
    apiKey: readApiKey(),
    baseUrl: OPENROUTER_BASE_URL,
    ...(temperature !== undefined
      ? { defaultParameters: { temperature } }
      : {}),
  });
}

/** True when OpenRouter is configured. Lets callers fall back rather than throw. */
export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
