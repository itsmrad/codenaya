import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { AiProviderKeySummary } from "../../../../convex/aiProviders";
import { ProviderKeyCard } from "./provider-key-card";

vi.mock("../hooks/use-ai-providers", () => ({
  useRemoveAiProviderKey: () => async () => {},
  testAiProviderKey: async () => {},
  aiProviderRequestError: async () => "",
}));

const providerKey = {
  _id: "key1",
  provider: "custom",
  label: "Team gateway",
  maskedPreview: "••••abcd",
  status: "active",
  baseUrl: "https://llm.example.com/v1",
} as unknown as AiProviderKeySummary;

it("names the key on its Test button and shows the full label and URL on hover", () => {
  const html = renderToStaticMarkup(createElement(ProviderKeyCard, { providerKey }));
  expect(html).toContain('aria-label="Test Team gateway"');
  expect(html).toContain('title="Team gateway"');
  expect(html).toContain('title="https://llm.example.com/v1"');
});
