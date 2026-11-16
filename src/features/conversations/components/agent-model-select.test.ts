import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AgentModelSelect } from "./agent-model-select";

vi.mock("@/features/ai-providers/hooks/use-ai-providers", () => ({
  useAiProviderKeys: () => [],
  usePlatformModelsOrCatalog: () => ({
    defaultModelId: "opus",
    models: [
      { id: "opus", name: "Claude Opus 5.5", vendor: "Anthropic" },
      { id: "haiku", name: "Claude Haiku 5.5", vendor: "Anthropic" },
      { id: "sol", name: "GPT 6.1 Sol", vendor: "OpenAI" },
    ],
  }),
}));

it.each(["opus", "haiku", "sol"])("keeps a stable, bounded trigger for %s", (modelId) => {
  const html = renderToStaticMarkup(createElement(AgentModelSelect, {
    value: { modelId }, onValueChange: vi.fn(),
  }));
  const trigger = html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0];
  expect(trigger).toContain("w-56");
  expect(trigger).toContain("max-w-full");
  expect(trigger).not.toContain("w-fit");
});
