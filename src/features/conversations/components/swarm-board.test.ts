import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import type { SwarmTask } from "../swarm-status";
import { SwarmBoard } from "./swarm-board";

vi.mock("./agent-run", () => ({ AgentRunLog: () => null }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => 1000 }));

const message: Doc<"messages"> = {
  _id: "message" as Id<"messages">, _creationTime: 0,
  projectId: "project" as Id<"projects">, conversationId: "conversation" as Id<"conversations">,
  role: "assistant", content: "", status: "processing", mode: "swarm",
};
const worker = (selfCheck?: string): SwarmTask => ({
  taskId: "hero", role: "worker", title: "Hero section", model: "Haiku 5.5",
  status: "done", steps: [], updatedAt: 1000, selfCheck,
});
const board = (tasks?: SwarmTask[]) => renderToStaticMarkup(createElement(SwarmBoard, { message, tasks }));

describe("SwarmBoard", () => {
  it("shows Planning for an empty processing orchestrator, including while workers load", () => {
    expect(board()).toContain("Loading workers…");
    expect(board([])).toContain("Planning…");
    expect(board([])).not.toContain("Starting…");
  });

  it.each([
    ["scoped-ok", "ok"], ["scoped-failed (2 in owned files)", "failed"],
    ["skipped (cost budget)", "skipped"], ["running", "running"],
  ])("shows the %s badge and preserves its explanation", (value, label) => {
    const html = board([worker(value)]);
    expect(html).toContain(`Self-check ${label}</span>`);
    expect(html).toContain(`title="${value}"`);
    expect(html).toContain(`aria-label="Worker: Hero section, Done, self-check ${label}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("focus-visible:ring-ring");
  });

  it("leaves legacy workers without a self-check badge", () => {
    expect(board([worker()])).not.toContain("Self-check");
  });

  it("nests child workers in a named list after the lead and before direct workers", () => {
    const child = { ...worker(), parentTaskId: "lead" };
    const lead = { ...worker(), taskId: "lead", title: "Page sections", role: "sub-orchestrator" as const };
    const direct = { ...worker(), taskId: "footer", title: "Footer" };
    const html = board([lead, direct, child]);
    expect(html).toContain('aria-label="Page sections workers"');
    expect(html.indexOf("Sub-orchestrator: Page sections")).toBeLessThan(html.indexOf("Worker: Hero section"));
    expect(html.indexOf("Worker: Hero section")).toBeLessThan(html.indexOf("Worker: Footer"));
    expect(html).toContain('aria-expanded="true"');
  });
});
