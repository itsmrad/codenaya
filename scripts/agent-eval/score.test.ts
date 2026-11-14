import { describe, expect, it } from "vitest";
import { tokenCost } from "./cost";
import { score } from "./score";
import { isRuntimeError, sanitize } from "./capture";
import { assertDevTarget } from "./guard";
import type { Trail } from "./types";

const fixture = (): Trail => ({
  id: "booking", model: "claude-haiku-5-5", prompt: "booking", startedAt: 1000, endedAt: 9000,
  firstPreviewAt: 5000, capped: false, consoleErrors: [], sandboxEvents: [],
  preview: { loaded: true, overlay: false },
  messages: [{ _id: "assistant" as Trail["messages"][number]["_id"], role: "assistant", status: "completed", content: "Done", runModel: { modelId: "claude-haiku-5-5", label: "Haiku" }, steps: [{ id: "build", kind: "tool", tool: "checkBuild", status: "done", text: "Build verified", startedAt: 2000 }] }],
  usage: [{ messageId: "assistant", model: "Codenaya · Claude Haiku 5.5", source: "platform", inputTokens: 10000, outputTokens: 2000, costUsd: 0.002 }],
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
  it("fails the preview on a runtime error in the final load and drops HMR noise", () => {
    const trail = fixture();
    trail.consoleErrors = [
      { text: "WebSocket connection to 'wss://4000-abc.e2b.app/?token=x' failed: Error during WebSocket handshake", url: "https://4000-abc.e2b.app/" },
      { text: "[vite] failed to connect to websocket.\nyour current setup:", url: "https://4000-abc.e2b.app/" },
      { text: "Invalid hook call.", url: "https://4000-abc.e2b.app/" },
    ];
    trail.preview.errors = ["WebSocket connection to 'wss://localhost:5173/' failed: net::ERR_CONNECTION_REFUSED"];
    expect(score(trail, [])).toMatchObject({ previewOk: true, consoleErrors: [{ text: "Invalid hook call." }] });
    trail.preview.errors.push("TypeError: Cannot read properties of null (reading 'useContext')");
    expect(score(trail, []).previewOk).toBe(false);
    expect(isRuntimeError("Uncaught ReferenceError: x is not defined")).toBe(true);
    expect(isRuntimeError("Failed to load resource: 404")).toBe(false);
  });
  it("prices tiers and cache usage; rejects unknown models and invalid usage", () => {
    expect(tokenCost("claude-haiku-5-5", 10000, 2000)).toBe(0.002);
    expect(tokenCost("claude-haiku-5-5", 100001, 2000)).toBeCloseTo(0.0550005);
    expect(tokenCost("claude-sonnet-5-5", 1000, 1000, 1000, 1000)).toBeCloseTo(0.0146);
    expect(tokenCost("claude-opus-5-5", 1000, 1000, 1000, 1000)).toBeCloseTo(0.0292);
    expect(() => tokenCost("unknown", 0, 0)).toThrow();
    expect(() => tokenCost("claude-haiku-5-5", -1, 0)).toThrow();
  });
  it("refuses anything but dev Clerk, the dev Convex deployment and a local app", () => {
    const dev = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x", CLERK_SECRET_KEY: "sk_test_x", NEXT_PUBLIC_CONVEX_URL: "https://outgoing-buffalo-802.convex.cloud" };
    expect(() => assertDevTarget(dev, "http://localhost:3213")).not.toThrow();
    expect(() => assertDevTarget(dev, "http://127.0.0.1:3213")).not.toThrow();
    for (const [env, url] of [
      [{ ...dev, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_x" }, "http://localhost:3213"],
      [{ ...dev, CLERK_SECRET_KEY: "sk_live_x" }, "http://localhost:3213"],
      [{ ...dev, NEXT_PUBLIC_CONVEX_URL: "https://prod-deployment-123.convex.cloud" }, "http://localhost:3213"],
      [{ ...dev, NEXT_PUBLIC_CONVEX_URL: "https://evil.example/outgoing-buffalo-802" }, "http://localhost:3213"],
      [{ ...dev, NEXT_PUBLIC_CONVEX_URL: undefined }, "http://localhost:3213"],
      [dev, "https://codenaya.app"],
      [dev, "http://localhost.evil.example"],
    ] as const) expect(() => assertDevTarget(env, url)).toThrow(/Refusing/);
  });
  it("redacts credentials and signed URLs from persisted diagnostics", () => {
    process.env.EVAL_TEST_SECRET = "secret-for-eval-test";
    try {
      const text = sanitize({ error: "secret-for-eval-test https://test.e2b.app/?token=abc wss://4000-x.e2b.app/?token=hmr" });
      for (const leaked of ["secret-for-eval-test", "token=abc", "token=hmr"]) expect(text).not.toContain(leaked);
    }
    finally { delete process.env.EVAL_TEST_SECRET; }
  });
});
