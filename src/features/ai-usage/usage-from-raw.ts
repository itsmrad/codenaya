/**
 * Token counts from a provider's raw chat response (AgentKit's
 * `AgentResult.raw`, the JSON string `step.ai.infer` returned). OpenAI-shaped
 * providers (OpenRouter, OpenAI, Groq) send `prompt_tokens`/`completion_tokens`;
 * Anthropic sends `input_tokens`/`output_tokens` with cache reads and writes
 * counted apart, so those are added back in.
 *
 * Missing or malformed usage counts as zero and is logged without content: a
 * run must not fail because a provider left usage out.
 */
export function usageFromRaw(raw: string | undefined): { inputTokens: number; outputTokens: number } {
  let usage: Record<string, unknown> | undefined;
  try {
    usage = (JSON.parse(raw ?? "") as { usage?: Record<string, unknown> })?.usage;
  } catch {
    usage = undefined;
  }
  const count = (...keys: string[]) =>
    keys.reduce((sum, key) => {
      const n = usage?.[key];
      return sum + (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
    }, 0);

  const inputTokens = count("prompt_tokens", "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens");
  const outputTokens = count("completion_tokens", "output_tokens");
  if (inputTokens === 0 && outputTokens === 0) {
    console.warn("[ai-usage] model response carried no token usage");
  }
  return { inputTokens, outputTokens };
}
