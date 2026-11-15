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
 * A second patch (`+002+openai-length-cutoff`) keeps the OpenAI parser from
 * throwing on a tool call cut off at the output limit (#493).
 */

/**
 * Output cap for Anthropic, which has no default (#493). Thinking counts toward
 * it, so it leaves room for thinking plus one bounded write batch
 * (`WRITE_BATCH_FILES`). Within every listed model's limit (128K; 64K on Haiku
 * 4.5) and low enough for a non-streaming request to finish in a few minutes.
 * A reply that still hits it is caught in the run (`inngest/lib/output-limit.ts`).
 */
export const ANTHROPIC_MAX_TOKENS = 32_000;

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
  //
  // AgentKit defaults parameterized tools to strict mode, which rejects our
  // optional fields (#566). Opt out without changing schemas or validation.
  return {
    ...adapter,
    onCall(...args: Parameters<NonNullable<typeof adapter.onCall>>) {
      adapter.onCall?.(...args);
      const body = args[1];
      for (const tool of body.tools ?? []) tool.function.strict = false;
      if (body.parallel_tool_calls !== false) return;
      if (parallel) body.parallel_tool_calls = true;
      else delete body.parallel_tool_calls;
    },
  };
}

type AgentKitModel = ReturnType<typeof buildAgentKitModel>;
type RequestBody = Record<string, unknown>;

/** The same model with every request's `tool_choice` (and `extra` fields) set, only on a request that carries tools. */
function withToolChoice(model: AgentKitModel, anthropicChoice: unknown, openaiChoice: unknown, extra?: RequestBody): AgentKitModel {
  const onCall = model.onCall as ((adapter: unknown, body: RequestBody) => void) | undefined;
  return {
    ...model,
    onCall(adapter: unknown, body: RequestBody) {
      onCall?.(adapter, body);
      if (!body.tools) return;
      body.tool_choice = model.format === "anthropic" ? anthropicChoice : openaiChoice;
      Object.assign(body, extra);
    },
  } as AgentKitModel;
}

/**
 * The same model with tool calls turned off, for a turn that must answer in
 * text. Its tools stay in the request: some providers reject tool calls in the
 * history of a request that declares no tools.
 */
export const withoutToolCalls = (model: AgentKitModel) => withToolChoice(model, { type: "none" }, "none");

// Official hosts and OpenAI-family models known to honour a forced tool_choice; anything else may reject it.
const FORCEABLE_BASE_URLS = ["https://api.openai.com/", "https://api.groq.com/"];
const FORCEABLE_MODEL_RE = /^(?:openai\/)?(?:gpt-|o\d)/i;

/**
 * How a turn that must call one tool can ask for it. Claude rejects a forced tool_choice
 * while it thinks, and only Haiku can turn thinking off (see ai-sdk-model.ts), so other
 * Claude models, like other models and hosts, get "auto": the caller nudges instead.
 */
export const toolForcing = (model: AgentKitModel): "force" | "force-thinking-off" | "auto" => {
  const { model: name = "", baseUrl = "" } = (model.options ?? {}) as { model?: string; baseUrl?: string };
  if (/claude/i.test(name)) return /haiku/i.test(name) ? "force-thinking-off" : "auto";
  return model.format === "openai-chat" && FORCEABLE_MODEL_RE.test(name)
    && FORCEABLE_BASE_URLS.some((url) => baseUrl.startsWith(url)) ? "force" : "auto";
};

/** The same model made to call the tool `name` where `toolForcing` allows it; otherwise unchanged. */
export const forceToolCall = (model: AgentKitModel, name: string) => {
  const forcing = toolForcing(model);
  if (forcing === "auto") return model;
  const anthropic = model.format === "anthropic";
  const thinkingOff = anthropic ? { thinking: { type: "disabled" } } : { reasoning: { enabled: false } };
  return withToolChoice(model, { type: "tool", name }, { type: "function", function: { name } },
    forcing === "force-thinking-off" ? thinkingOff : undefined);
};
