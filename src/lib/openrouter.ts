import { createOpenAI } from "@ai-sdk/openai";

/**
 * Shared OpenRouter configuration, the single LLM provider for the app.
 *
 * The Inngest agent builds AgentKit models from these values
 * (`features/conversations/inngest/lib/openrouter-model.ts`); the editor AI
 * routes (`/api/suggestion`, `/api/quick-edit`, `/api/enhance-prompt`) build
 * AI SDK models through `editorModel()` below.
 *
 * Configuration is read at call time, not module load, so importing this file
 * never fails when the key is absent (that would break `next build`).
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function readOpenRouterApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    // The message names the variable to set, wherever the error surfaces.
    throw new Error(
      "OPENROUTER_API_KEY is not configured. Add it to .env.local and to the " +
        "deployment environment.",
    );
  }

  return apiKey;
}

/** True when OpenRouter is configured. Lets callers fall back rather than throw. */
export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * Editor AI tasks. All are short, latency-sensitive generations, so a small,
 * cheap model is the default. Each can be overridden with an OpenRouter model id
 * in the named env var.
 */
export const EDITOR_AI_MODELS = {
  suggestion: {
    env: "OPENROUTER_SUGGESTION_MODEL",
    fallback: "openai/gpt-5.4-mini",
  },
  quickEdit: {
    env: "OPENROUTER_QUICK_EDIT_MODEL",
    fallback: "openai/gpt-5.4-mini",
  },
  enhancePrompt: {
    env: "OPENROUTER_ENHANCE_PROMPT_MODEL",
    fallback: "openai/gpt-5.4-mini",
  },
} as const;

export type EditorAiTask = keyof typeof EDITOR_AI_MODELS;

export function editorModelId(task: EditorAiTask): string {
  const { env, fallback } = EDITOR_AI_MODELS[task];
  return process.env[env]?.trim() || fallback;
}

/**
 * The platform AI SDK model for an editor AI task. Users with a default BYOK
 * key get their own provider instead (`features/ai-providers/server/editor-model.ts`).
 *
 * Uses Chat Completions (`.chat`), the OpenAI-compatible API OpenRouter serves.
 */
export function editorModel(task: EditorAiTask) {
  const openrouter = createOpenAI({
    apiKey: readOpenRouterApiKey(),
    baseURL: OPENROUTER_BASE_URL,
  });

  return openrouter.chat(editorModelId(task));
}
