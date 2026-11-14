import { describe, expect, it } from "vitest";

import { AGENT_MODELS, DEFAULT_AGENT_MODEL_ID, nextTier } from "./agent-models";

describe("agent model allowlist", () => {
  it("offers 15 unique models including the default", () => {
    const ids = AGENT_MODELS.map((model) => model.id);

    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_AGENT_MODEL_ID);
  });
});

describe("nextTier", () => {
  const ids = new Set<string>(AGENT_MODELS.map((model) => model.id));

  it.each([
    ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"],
    ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"],
    ["openai/gpt-6-luna", "openai/gpt-6.1-sol"],
    ["google/gemini-3.8-flash", "google/gemini-3.1-pro-preview"],
    ["x-ai/grok-4.7", "anthropic/claude-sonnet-5.5"],
    ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-5.5"],
  ])("steps %s up to %s", (from, to) => {
    expect(nextTier(from)?.id).toBe(to);
  });

  it.each([
    "anthropic/claude-opus-5.5",
    "anthropic/claude-fable-5.1",
    "openai/gpt-6.1-sol",
    "google/gemini-3.1-pro-preview",
  ])("has nothing above %s", (id) => {
    expect(nextTier(id)).toBeNull();
  });

  it("offers nothing for ids outside the catalog, and never throws", () => {
    for (const id of ["claude-sonnet-5-5", "retired/model", "", "toString", "__proto__"]) {
      expect(nextTier(id)).toBeNull();
    }
  });

  it("always lands on a catalog model, with a cost range", () => {
    for (const { id } of AGENT_MODELS) {
      const next = nextTier(id);
      if (next) expect(ids.has(next.id)).toBe(true);
    }
    const opus = nextTier("anthropic/claude-sonnet-5.5");
    expect(opus?.label).toBe("Claude Opus 5.5");
    expect(opus?.costUsd[0]).toBeCloseTo(0.296);
    expect(opus?.costUsd[1]).toBeCloseTo(0.592);
  });
});
