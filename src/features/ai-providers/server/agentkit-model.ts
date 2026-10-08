import { anthropic, openai } from "@inngest/agent-kit";

import { baseUrlFor, type AiProviderId } from "../registry";

/**
 * AgentKit model for any supported provider.
 *
 * OpenRouter, OpenAI and custom endpoints all speak OpenAI Chat Completions,
 * so they share AgentKit's `openai()` adapter and differ only in `baseUrl`.
 * Anthropic gets its native adapter, which requires `max_tokens` on every
 * request.
 */

/** Output cap for Anthropic, which has no default. Enough for large file writes. */
export const ANTHROPIC_MAX_TOKENS = 16_384;

export interface ModelTarget {
  provider: AiProviderId;
  apiKey: string;
  /** Custom endpoints only. */
  baseUrl?: string;
  model: string;
  /** Omitted for models that reject a non-default temperature. */
  temperature?: number;
}

export function buildAgentKitModel({
  provider,
  apiKey,
  baseUrl,
  model,
  temperature,
}: ModelTarget) {
  const url = baseUrlFor({ provider, baseUrl });
  const sampling = temperature !== undefined ? { temperature } : {};

  if (provider === "anthropic") {
    return anthropic({
      model,
      apiKey,
      baseUrl: url,
      defaultParameters: { max_tokens: ANTHROPIC_MAX_TOKENS, ...sampling },
    });
  }

  return openai({
    model,
    apiKey,
    baseUrl: url,
    ...(temperature !== undefined ? { defaultParameters: sampling } : {}),
  });
}
