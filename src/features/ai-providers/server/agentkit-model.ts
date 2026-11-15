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

// ─── Prompt caching ───
//
// Claude caches a request's prefix up to each `cache_control` breakpoint, in the
// order tools → system → messages, at 0.1x the input price on a hit and 1.25x
// on a write (5-minute TTL). A run resends tools, the system prompt and the
// whole history on every step, so breakpoints make most of that a cache read.
// The prefix must be byte-stable: anything that varies goes after the shared
// system prefix, never before it.

const EPHEMERAL = { type: "ephemeral" } as const;
type Block = Record<string, unknown>;
type CacheMessage = { role?: string; content?: unknown };

/** Text content as one text block, so a message is sent the same way whether or not it carries a breakpoint. */
const asBlocks = (content: unknown) =>
  typeof content === "string" && content ? [{ type: "text", text: content }] : content;

/** The blocks with a breakpoint on the last; unchanged when there is none. */
const withBreakpoint = (content: unknown) =>
  Array.isArray(content) && content.length > 0
    ? (content as Block[]).map((block, i) => (i === content.length - 1 ? { ...block, cache_control: EPHEMERAL } : block))
    : content;

/** The system prompt as blocks: the shared prefix ends in a breakpoint, the rest of the run's system follows it. */
function systemBlocks(system: string, sharedPrefix: string): Block[] {
  const shared = sharedPrefix && system.startsWith(sharedPrefix) ? sharedPrefix : system;
  const rest = system.slice(shared.length);
  return [
    { type: "text", text: shared, cache_control: EPHEMERAL },
    ...(rest ? [{ type: "text", text: rest }] : []),
  ];
}

/**
 * Native Anthropic: four breakpoints, the most allowed. The last tool and the
 * shared system prefix are shared across runs (and swarm workers); the last two
 * messages roll forward each step, so the next step reads this one's history.
 * Two, because a step's last message may be a one-off nudge the next step drops.
 */
function cacheAnthropicRequest(body: RequestBody, sharedPrefix: string) {
  const tools = body.tools as Block[] | undefined;
  if (tools?.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: EPHEMERAL };
  if (typeof body.system === "string" && body.system) body.system = systemBlocks(body.system, sharedPrefix);
  const messages = (body.messages ?? []) as CacheMessage[];
  for (const message of messages) message.content = asBlocks(message.content);
  for (const message of messages.slice(-2)) message.content = withBreakpoint(message.content);
}

/**
 * OpenRouter to a Claude model: a breakpoint on the shared system prefix (the
 * tools render before it, so they are cached with it) and top-level automatic
 * caching for the rolling history. OpenRouter documents neither on tool
 * definitions nor on tool messages.
 */
function cacheOpenRouterClaudeRequest(body: RequestBody, sharedPrefix: string) {
  const system = ((body.messages ?? []) as CacheMessage[]).find((m) => m.role === "system");
  if (system && typeof system.content === "string" && system.content) {
    system.content = systemBlocks(system.content, sharedPrefix);
  }
  body.cache_control = EPHEMERAL;
}

const OPENROUTER_URL = "https://openrouter.ai/";
const isClaude = (name: string) => /claude|anthropic\//i.test(name);

/**
 * The same model with prompt-cache breakpoints on every request, for Claude
 * natively or through OpenRouter; other models are unchanged. `sharedPrefix`
 * is the start of the system prompt that is identical across runs: the cache
 * shares it when the system prompt starts with it, else the whole system
 * prompt is the cached block.
 */
export function withPromptCache(model: AgentKitModel, sharedPrefix = ""): AgentKitModel {
  const onCall = model.onCall as ((adapter: unknown, body: RequestBody) => void) | undefined;
  const { model: name = "", baseUrl = "" } = (model.options ?? {}) as { model?: string; baseUrl?: string };
  const cache = model.format === "anthropic"
    ? cacheAnthropicRequest
    : model.format === "openai-chat" && baseUrl.startsWith(OPENROUTER_URL) && isClaude(name)
      ? cacheOpenRouterClaudeRequest
      : undefined;
  if (!cache) return model;
  return {
    ...model,
    onCall(adapter: unknown, body: RequestBody) {
      onCall?.(adapter, body);
      cache(body, sharedPrefix);
    },
  } as AgentKitModel;
}
