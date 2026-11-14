import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type AgentStep, BUILD_VERIFIED, FIRST_STEP_HINT_MS, SLOW_RUN_MS } from "../agent-steps";
import { AgentRun } from "./agent-run";

// The run diff loads from Convex; the header under test doesn't need it.
vi.mock("../hooks/use-checkpoints", () => ({ useRunChanges: () => undefined }));

const step = (id: string, tool: string, status: AgentStep["status"], extra: Partial<AgentStep> = {}): AgentStep => ({
  id,
  kind: "tool",
  tool,
  status,
  startedAt: 0,
  endedAt: 1_000,
  ...extra,
});

const header = (steps: AgentStep[]) =>
  renderToStaticMarkup(createElement(AgentRun, { steps, status: "completed", startedAt: 0, completedAt: 1_000 }));

describe("AgentRun header", () => {
  it("reports a fixed build instead of counting its failed checks as errors", () => {
    const html = header([
      step("a", "checkBuild", "error", { error: "Error: Build failed." }),
      step("b", "updateFile", "done", { targets: ["src/App.tsx"] }),
      step("c", "checkBuild", "error", { error: "Error: Build failed." }),
      step("d", "updateFile", "done", { targets: ["src/App.tsx"] }),
      step("e", "checkBuild", "done", { text: BUILD_VERIFIED }),
    ]);
    expect(html).toContain("Fixed the build");
    expect(html).not.toMatch(/\d+ errors?</);
  });

  it("still counts a build error the agent did not fix", () => {
    const html = header([step("a", "checkBuild", "error", { error: "Error: Build failed." })]);
    expect(html).not.toContain("Fixed");
    expect(html).toContain("1 error");
  });
});

// #478: a live run that has gone quiet shows an honest status line.
describe("AgentRun while live", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const live = (steps: AgentStep[], elapsed: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + elapsed);
    return renderToStaticMarkup(
      createElement(AgentRun, { steps, status: "processing", startedAt: 1_000_000, model: "Claude Haiku 5.5" }),
    );
  };

  it("shows only the loader and timer at first, with an empty live region ready", () => {
    const html = live([], 5_000);
    expect(html).toContain("Thinking…");
    expect(html).toContain('<p role="status" class="sr-only"></p>');
  });

  it("explains a long first step under the row", () => {
    const html = live([], FIRST_STEP_HINT_MS + 1_000);
    expect(html).toMatch(/role="status"[^>]*>Planning the work\. The first step can take a minute or two\.</);
  });

  it("says when the run is taking longer than usual", () => {
    expect(live([], SLOW_RUN_MS + 1_000)).toContain("Taking longer than usual");
  });

  it("stays quiet while steps keep arriving", () => {
    const html = live([step("a", "writeFiles", "running", { startedAt: 1_000_000 + 25_000, endedAt: undefined })], 30_000);
    expect(html).toContain('<p role="status" class="sr-only"></p>');
  });

  it("shows no hint once the run has finished", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + SLOW_RUN_MS * 2);
    const html = renderToStaticMarkup(
      createElement(AgentRun, { steps: [], status: "completed", startedAt: 1_000_000, completedAt: 1_000_000 + 10_000 }),
    );
    expect(html).not.toContain("Taking longer");
    expect(html).not.toContain("Planning the work");
  });
});
