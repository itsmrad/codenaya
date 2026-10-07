import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

import { baseUrlFor } from "../registry";
import type { ModelTarget } from "./agentkit-model";
import { providerFetch } from "./base-url";

/**
 * AI SDK model for any supported provider, for the editor AI routes. These
 * requests leave from our server, so a custom endpoint goes through the SSRF
 * guarded fetch on every call.
 *
 * OpenRouter and custom endpoints use Chat Completions (`.chat`), the
 * OpenAI-compatible API they serve; OpenAI direct uses the SDK default.
 */
export function buildAiSdkModel({
  provider,
  apiKey,
  baseUrl,
  model,
}: Omit<ModelTarget, "temperature">) {
  const baseURL = baseUrlFor({ provider, baseUrl });

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model);
    case "openrouter":
      return createOpenAI({ apiKey, baseURL }).chat(model);
    case "custom":
      return createOpenAI({
        apiKey,
        baseURL,
        fetch: providerFetch(baseURL),
      }).chat(model);
  }
}
