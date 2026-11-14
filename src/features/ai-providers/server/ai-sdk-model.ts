import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

import { baseUrlFor, type AiProviderId } from "../registry";
import type { ModelTarget } from "./agentkit-model";
import { providerFetch } from "./base-url";

/**
 * Haiku thinks by default, which puts inline suggestions at ~13 s to the first
 * token (#320). Each provider's switch to turn it off, sent as a body field
 * because the AI SDK's OpenAI chat options can't carry OpenRouter's `reasoning`.
 * Haiku only: other Claude models reject disabled thinking.
 */
const THINKING_OFF: Partial<Record<AiProviderId, { prefix: string; body: object }>> = {
  openrouter: { prefix: "anthropic/claude-haiku", body: { reasoning: { enabled: false } } },
  anthropic: { prefix: "claude-haiku", body: { thinking: { type: "disabled" } } },
};

const withBody = (extra: object): typeof fetch => (input, init) =>
  fetch(
    input,
    typeof init?.body === "string"
      ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) }
      : init,
  );

/**
 * AI SDK model for any supported provider, for the editor AI routes. These
 * requests leave from our server, so a custom endpoint goes through the SSRF
 * guarded fetch on every call.
 *
 * OpenRouter, Groq and custom endpoints use Chat Completions (`.chat`), the
 * OpenAI-compatible API they serve; OpenAI direct uses the SDK default.
 *
 * `thinking: false` turns thinking off where the model allows it (Haiku), for
 * latency-bound calls. Other models are unchanged.
 */
export function buildAiSdkModel({
  provider,
  apiKey,
  baseUrl,
  model,
  thinking = true,
}: Omit<ModelTarget, "temperature"> & { thinking?: boolean }) {
  const baseURL = baseUrlFor({ provider, baseUrl });
  const off = THINKING_OFF[provider];
  const fetch = !thinking && off && model.startsWith(off.prefix) ? withBody(off.body) : undefined;

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL, fetch })(model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model);
    case "openrouter":
      return createOpenAI({ apiKey, baseURL, fetch }).chat(model);
    case "groq":
      return createOpenAI({ apiKey, baseURL }).chat(model);
    case "custom":
      return createOpenAI({
        apiKey,
        baseURL,
        fetch: providerFetch(baseURL),
      }).chat(model);
  }
}
