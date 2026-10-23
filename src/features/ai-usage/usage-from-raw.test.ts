import { describe, expect, it, vi } from "vitest";

import { usageFromRaw } from "./usage-from-raw";

describe("usageFromRaw", () => {
  it.each([
    ["OpenRouter/OpenAI/Groq", { usage: { prompt_tokens: 1_200, completion_tokens: 30, total_tokens: 1_230 } }, 1_200, 30],
    [
      "Anthropic, cache reads and writes counted as input",
      { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 40 } },
      1_050,
      40,
    ],
  ])("reads %s", (_, body, inputTokens, outputTokens) => {
    expect(usageFromRaw(JSON.stringify(body))).toEqual({ inputTokens, outputTokens });
  });

  it.each([
    ["missing usage", JSON.stringify({ choices: [] })],
    ["invalid JSON", "{not json"],
    ["no response", undefined],
    ["junk counts", JSON.stringify({ usage: { prompt_tokens: -5, completion_tokens: "9" } })],
  ])("counts %s as zero and warns", (_, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(usageFromRaw(raw)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(warn).toHaveBeenCalledWith("[ai-usage] model response carried no token usage");
    warn.mockRestore();
  });
});
