import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { type AgentStep, BUILD_VERIFIED } from "../agent-steps";
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
