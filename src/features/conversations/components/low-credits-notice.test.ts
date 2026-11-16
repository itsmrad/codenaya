import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUTO_MODEL_ID } from "@/features/ai-providers/auto-route";
import type { PublicCatalogModel } from "@/features/ai-providers/catalog";

import { LowCreditsNotice } from "./low-credits-notice";

const SONNET_ID = "anthropic/claude-sonnet-5.5";

const harness = vi.hoisted(() => ({
  usage: {
    isLow: false,
    day: { left: 20, total: 60, percentLeft: 33 },
    month: { left: 200, total: 300, percentLeft: 67 },
  },
  models: [
    {
      id: "openai/gpt-6-luna",
      name: "GPT-6 Luna",
      vendor: "OpenAI",
      vision: true,
      access: "everyone",
      pricing: { mode: "blended", usdPerMTok: 1 },
    },
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      vendor: "Anthropic",
      vision: true,
      access: "everyone",
      pricing: { mode: "split", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    },
  ] as PublicCatalogModel[],
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

vi.mock("@/features/billing/hooks/use-credit-usage", () => ({
  useCreditUsage: () => harness.usage,
}));

vi.mock("@/features/ai-providers/hooks/use-ai-providers", () => ({
  usePlatformModelsOrCatalog: () => ({
    models: harness.models,
    defaultModelId: "openai/gpt-6-luna",
    promoModelIds: [],
  }),
}));

const render = (modelId?: string) =>
  renderToStaticMarkup(createElement(LowCreditsNotice, { modelId }));

beforeEach(() => {
  harness.usage = {
    isLow: false,
    day: { left: 20, total: 60, percentLeft: 33 },
    month: { left: 200, total: 300, percentLeft: 67 },
  };
});

describe("LowCreditsNotice", () => {
  it("stays hidden when not low and remaining credits cover minRunCredits(model.pricing)", () => {
    expect(render(SONNET_ID)).toBe("");
  });

  it("warns when remaining credits are below minRunCredits(model.pricing) even if above 20%", () => {
    // 30k in + 2k out at $2/$10 * 1.5x / $0.01 = 12 credits
    harness.usage.day = { left: 7, total: 30, percentLeft: 23 };
    const html = render(SONNET_ID);
    expect(html).toContain("Only 7 credits left today (~12 needed to start).");
  });

  it("does not show needed to start for Auto when at least 1 credit remains", () => {
    harness.usage.isLow = true;
    harness.usage.day = { left: 7, total: 60, percentLeft: 12 };
    const html = render(AUTO_MODEL_ID);
    expect(html).toContain("Only 7 credits left today.");
    expect(html).not.toContain("needed to start");
  });
});
