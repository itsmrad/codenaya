import { describe, expect, it } from "vitest";

import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL_ID,
  resolveAgentModelId,
} from "./agent-models";

describe("agent model allowlist", () => {
  it("offers 15 unique models including the default", () => {
    const ids = AGENT_MODELS.map((model) => model.id);

    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_AGENT_MODEL_ID);
  });

  it("accepts every allowlisted id", () => {
    for (const { id } of AGENT_MODELS) {
      expect(resolveAgentModelId(id)).toBe(id);
    }
  });

  it.each([
    undefined,
    null,
    "",
    "openai/not-a-real-model",
    "OPENAI/GPT-5.6-LUNA",
    " openai/gpt-5.6-luna",
    42,
    { id: "openai/gpt-5.6-luna" },
  ])("falls back to the default for %j", (value) => {
    expect(resolveAgentModelId(value)).toBe(DEFAULT_AGENT_MODEL_ID);
  });
});
