import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { LandingModelPicker } from "./landing-model-picker";

vi.mock("convex/react", () => ({
  useQuery: () => ({ defaultModelId: "opus", models: [{ id: "opus", name: "Claude Opus 5.5", vendor: "Anthropic", access: "everyone" }] }),
}));
vi.mock("@/features/conversations/hooks/use-agent-model", () => ({
  useStoredAgentModel: () => null, setModel: vi.fn(),
}));

it("fills the remaining toolbar width without adding a divider before Clear", () => {
  const html = renderToStaticMarkup(createElement(LandingModelPicker));
  expect(html).toContain('class="relative flex min-w-0 flex-1"');
  expect(html).toMatch(/<button[^>]*class="[^"]*w-full/);
  expect(html).not.toContain("border-r");
});
