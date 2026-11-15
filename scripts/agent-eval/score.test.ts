import { describe, expect, it } from "vitest";
import { tokenCost } from "./cost";
import { score } from "./score";
import { isGeneratedApp, isRuntimeError, routeUrl, sanitize, screenshotFile } from "./capture";
import { assertDevTarget } from "./guard";
import { ADMIN_TITLE, deleteAfterScoring, projectTitle } from "./projects";
import type { Trail } from "./types";

const fixture = (): Trail => ({
  id: "booking", model: "claude-haiku-5-5", mode: "build", prompt: "booking", tasks: [], startedAt: 1000, endedAt: 9000,
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
  it("drops Next's dev websocket and HMR noise but keeps its real errors", () => {
    const trail = fixture();
    const url = "https://3000-abc.e2b.app/";
    trail.consoleErrors = [
      { text: "WebSocket connection to 'wss://3000-abc.e2b.app/_next/webpack-hmr' failed: Error during WebSocket handshake", url },
      { text: "WebSocket connection to 'ws://localhost:3000/_next/webpack-hmr?id=x' failed: net::ERR_CONNECTION_REFUSED", url },
      { text: "[HMR] connected", url },
      { text: "[Fast Refresh] performing full reload", url },
      { text: "Unhandled Runtime Error: Invalid hook call.", url },
    ];
    expect(score(trail, []).consoleErrors).toEqual([{ text: "Unhandled Runtime Error: Invalid hook call.", url }]);
  });
  it("tells the generated app's first paint from the starter's", () => {
    expect(isGeneratedApp("App")).toBe(false);
    expect(isGeneratedApp("  \n")).toBe(false);
    expect(isGeneratedApp("Alex Rivera\nSelect a meeting type")).toBe(true);
    expect(isGeneratedApp("Something went wrong\nCannot read properties of null\nReload")).toBe(false);
    expect(isGeneratedApp("Alex Rivera", true)).toBe(false);
    const trail = fixture();
    trail.firstAppPaintAt = 7000;
    expect(score(trail, []).firstAppPaintMs).toBe(6000);
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
  it("summarizes a swarm from its agentTasks rows and the orchestrator's steps", () => {
    const trail = fixture();
    trail.mode = "swarm";
    const messageId = trail.messages[0]._id;
    trail.messages[0].completedAt = 7000;
    trail.messages[0].steps = [
      { id: "plan", kind: "tool", tool: "delegateTasks", status: "done", startedAt: 3000 },
      { id: "fix", kind: "tool", tool: "editFile", status: "done", startedAt: 4000 },
      { id: "build", kind: "tool", tool: "checkBuild", status: "done", text: "Build verified", startedAt: 5000 },
    ];
    trail.tasks = [
      { messageId, taskId: "ui", role: "worker", status: "done", selfCheck: "scoped-ok" },
      { messageId, taskId: "data", role: "sub-orchestrator", status: "error" },
      { messageId, taskId: "data/api", role: "worker", status: "running", parentTaskId: "data", selfCheck: "skipped (swarm sandbox cap reached)" },
      { messageId, taskId: "data/db", role: "worker", status: "done", parentTaskId: "data", selfCheck: "scoped-failed (tsc)" },
    ];
    const result = score(trail, []);
    expect(result).toMatchObject({ mode: "swarm", messageMs: 6000, swarm: { tasksPlanned: 2, workers: 3, failed: 1, unfinished: 1, maxDepth: 2, integratorTurns: 2 } });
    expect(result.swarm!.selfChecks.map((c) => c.selfCheck)).toEqual(["ok", "skipped", "failed"]);
    expect(score(fixture(), []).swarm).toBeNull();
  });
  it("names one screenshot per route and keeps the sandbox host and query", () => {
    expect(["/", "/menu", "/location/hours/"].map(screenshotFile)).toEqual(["app.png", "app-menu.png", "app-location-hours.png"]);
    expect(routeUrl("https://5173-abc.e2b.app/?t=1", "/menu")).toBe("https://5173-abc.e2b.app/menu?t=1");
  });
  it("names projects from a title template and rejects invalid names", () => {
    expect(projectTitle(ADMIN_TITLE, "booking", "claude-haiku-5-5")).toBe("Night build — booking — single Haiku 5.5");
    expect(projectTitle("{app}/{config}/{app}", "saas", "google/gemini-4-hydrogen")).toBe("saas/single Gemini 4 Hydrogen/saas");
    expect(projectTitle(ADMIN_TITLE, "crm", "claude-sonnet-5-5", "swarm")).toBe("Night build — crm — Swarm Sonnet 5.5 + Haiku 5.5");
    expect(() => projectTitle(" ", "crm", "claude-opus-5-5")).toThrow(/--title/);
    expect(() => projectTitle("x".repeat(101), "crm", "claude-opus-5-5")).toThrow(/--title/);
  });
  it("never deletes admin builds, kept, unscored or follow-up projects", () => {
    const run = { asAdmin: false, keep: false, scored: true, followupPending: false };
    expect(deleteAfterScoring(run)).toBe(true);
    for (const change of [{ asAdmin: true }, { keep: true }, { scored: false }, { followupPending: true }]) {
      expect(deleteAfterScoring({ ...run, ...change })).toBe(false);
    }
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
