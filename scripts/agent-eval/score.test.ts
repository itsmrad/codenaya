import { describe, expect, it } from "vitest";
import { tokenCost } from "./cost";
import { score } from "./score";
import { sanitize } from "./capture";
import type { Trail } from "./types";

const fixture = (): Trail => ({
  id: "booking", model: "claude-haiku-5-5", prompt: "booking", startedAt: 1000, endedAt: 9000,
  firstPreviewAt: 5000, capped: false, consoleErrors: [], sandboxEvents: [],
  preview: { loaded: true, overlay: false },
  messages: [{ _id: "assistant" as Trail["messages"][number]["_id"], role: "assistant", status: "completed", content: "Done", runModel: { modelId: "claude-haiku-5-5", label: "Haiku" }, steps: [{ id: "build", kind: "tool", tool: "checkBuild", status: "done", text: "Build verified", startedAt: 2000 }] }],
  usage: [{ messageId: "assistant", model: "claude-haiku-5-5", source: "platform", inputTokens: 10000, outputTokens: 2000, costUsd: 0.002 }],
});

describe("agent evaluation", () => {
  it("scores completion, timing, build and actual ledger cost independently", () => {
    const result = score(fixture(), [{ path: "index.html", content: '<script src="/src/main.tsx"></script>' }]);
    expect(result).toMatchObject({ completed: true, tokensIn: 10000, tokensOut: 2000, usd: 0.002, wallMs: 8000, firstPreviewMs: 4000, missingReferencedFiles: ["src/main.tsx (referenced by index.html)"] });
    expect(result.checkBuild[0].passed).toBe(true);
  });
  it("does not mark failed, stuck, cancelled, capped or mismatched models complete", () => {
    for (const mutate of [
      (t: Trail) => { t.capped = true; },
      (t: Trail) => { t.messages[0].status = "cancelled"; },
      (t: Trail) => { t.messages[0].stuck = { reason: "repeated-error" }; },
      (t: Trail) => { t.messages[0].runModel!.modelId = "wrong"; },
      (t: Trail) => { t.messages[0].content = "My apologies, I encountered an error while processing your request. Let me know if you need anything else!"; },
    ]) { const trail = fixture(); mutate(trail); expect(score(trail, []).completed).toBe(false); }
  });
  it("counts tool failures and recognizes cap note without assuming tool count is model calls", () => {
    const trail = fixture();
    trail.messages[0].content = "Step budget reached: no more tool calls.";
    trail.messages[0].steps!.push({ id: "error", kind: "tool", tool: "editFile", status: "error", error: "Missing file", startedAt: 2000 });
    expect(score(trail, [])).toMatchObject({ iterationCapHit: true, toolErrorCount: 1, modelCallsApprox: 1 });
  });
  it("prices tiers and cache usage; rejects unknown models and invalid usage", () => {
    expect(tokenCost("claude-haiku-5-5", 10000, 2000)).toBe(0.002);
    expect(tokenCost("claude-haiku-5-5", 100001, 2000)).toBeCloseTo(0.0550005);
    expect(tokenCost("claude-sonnet-5-5", 1000, 1000, 1000, 1000)).toBeCloseTo(0.0146);
    expect(tokenCost("claude-opus-5-5", 1000, 1000, 1000, 1000)).toBeCloseTo(0.0292);
    expect(() => tokenCost("unknown", 0, 0)).toThrow();
    expect(() => tokenCost("claude-haiku-5-5", -1, 0)).toThrow();
  });
  it("redacts credentials and signed URLs from persisted diagnostics", () => {
    process.env.EVAL_TEST_SECRET = "secret-for-eval-test";
    try { expect(sanitize({ error: "secret-for-eval-test https://test.e2b.app/?token=abc" })).not.toContain("secret-for-eval-test"); }
    finally { delete process.env.EVAL_TEST_SECRET; }
  });
});
