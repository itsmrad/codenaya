import { anthropic, openai } from "@inngest/agent-kit";

import { AI_PROVIDERS, baseUrlFor, type AiProviderId } from "../registry";

/**
 * AgentKit model for any supported provider.
 *
 * OpenRouter, OpenAI, Groq and custom endpoints all speak OpenAI Chat Completions,
 * so they share AgentKit's `openai()` adapter and differ only in `baseUrl`.
 * Anthropic gets its native adapter, which requires `max_tokens` on every
 * request and never gets `temperature`: current Claude models reject it with a
 * 400 (`temperature` is deprecated for this model). Its response parser is
 * patched (patches/@inngest+agent-kit+*.patch) to skip `thinking` blocks it
 * would crash on; drop the patch once AgentKit handles unknown block types.
 */

/** Output cap for Anthropic, which has no default. Enough for large file writes. */
export const ANTHROPIC_MAX_TOKENS = 16_384;

export interface ModelTarget {
  provider: AiProviderId;
  apiKey: string;
  /** Custom endpoints only. */
  baseUrl?: string;
  model: string;
  /** Omitted for models that reject a non-default temperature. Never sent to Anthropic. */
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

  if (provider === "anthropic") {
    return anthropic({
      model,
      apiKey,
      baseUrl: url,
      defaultParameters: { max_tokens: ANTHROPIC_MAX_TOKENS },
    });
  }

  const adapter = openai({
    model,
    apiKey,
    baseUrl: url,
    ...(temperature !== undefined ? { defaultParameters: { temperature } } : {}),
  });
  const parallel = AI_PROVIDERS[provider].parallelToolCalls !== false;

  // AgentKit sends `parallel_tool_calls: false` with every tool list, so a turn
  // could make one call. Allow several, or drop the parameter for an endpoint
  // that rejects it. A request without tools (the title) never carries it.
  return {
    ...adapter,
    onCall(...args: Parameters<NonNullable<typeof adapter.onCall>>) {
      adapter.onCall?.(...args);
      const body = args[1];
      if (body.parallel_tool_calls !== false) return;
      if (parallel) body.parallel_tool_calls = true;
      else delete body.parallel_tool_calls;
    },
  };
}

type AgentKitModel = ReturnType<typeof buildAgentKitModel>;
type RequestBody = Record<string, unknown>;

/**
 * The same model with tool calls turned off, for a turn that must answer in
 * text. Its tools stay in the request: some providers reject tool calls in the
 * history of a request that declares no tools.
 */
export function withoutToolCalls(model: AgentKitModel): AgentKitModel {
  const onCall = model.onCall as ((adapter: unknown, body: RequestBody) => void) | undefined;
  return {
    ...model,
    onCall(adapter: unknown, body: RequestBody) {
      onCall?.(adapter, body);
      if (body.tools) body.tool_choice = model.format === "anthropic" ? { type: "none" } : "none";
    },
  } as AgentKitModel;
}
