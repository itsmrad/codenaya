import { describe, expect, it } from "vitest";

import type { AgentStep } from "./agent-steps";
import { FOUNDATION_MAX_STEPS } from "./swarm";
import { groupSwarmTasks, type SwarmTask, swarmElapsed, swarmHeader, swarmSelfCheckStatus, swarmSoloReason, swarmTaskStatus } from "./swarm-status";

describe("swarmTaskStatus", () => {
  it.each(["completed", "cancelled"] as const)("cancels unfinished tasks under a %s parent", (parent) => {
    expect(swarmTaskStatus("queued", parent)).toBe("cancelled");
    expect(swarmTaskStatus("running", parent)).toBe("cancelled");
    expect(swarmTaskStatus("done", parent)).toBe("done");
    expect(swarmTaskStatus("error", parent)).toBe("error");
  });

  it.each(["queued", "running", "done", "error"] as const)("preserves %s under a live parent", (status) => {
    expect(swarmTaskStatus(status, "processing")).toBe(status);
  });
});

describe("swarm header", () => {
  const task = (status: SwarmTask["status"], role: SwarmTask["role"] = "worker"): SwarmTask => ({
    taskId: "task", role, title: "Build navigation", model: "Haiku 5.5", status, steps: [], updatedAt: 0,
  });

  it("counts workers and finished tasks, excluding the parent run", () => {
    expect(swarmHeader([task("done"), task("done"), task("running")], 1000, 135000, undefined, completedSteps(FOUNDATION_MAX_STEPS)))
      .toBe("Swarm · 3 workers · 2:14 · 2 done");
  });

  const completedSteps = (count: number): AgentStep[] => Array.from({ length: count }, (_, i) => ({
    id: `step-${i}`, kind: "tool", tool: "writeFiles", status: "done", startedAt: i,
  }));

  it("shows foundation progress without counting running tools, thinking or heartbeats", () => {
    const steps: AgentStep[] = [
      ...completedSteps(3),
      { id: "pending", kind: "tool", tool: "writeFiles", status: "running", startedAt: 4 },
      { id: "thinking-step-0", kind: "thinking", status: "done", startedAt: 0 },
      { id: "turn-heartbeat", kind: "thinking", status: "done", startedAt: 4 },
    ];
    expect(swarmHeader([], 0, 97000, swarmSoloReason(steps, true), steps))
      .toBe(`Swarm · Setting up shared files · step 3/${FOUNDATION_MAX_STEPS} · 1:37`);
    expect(swarmHeader([], 0, 0)).toBe(`Swarm · Setting up shared files · step 0/${FOUNDATION_MAX_STEPS} · 0:00`);
  });

  it.each([FOUNDATION_MAX_STEPS, FOUNDATION_MAX_STEPS + 1])("shows planning after %s completed steps", (count) => {
    expect(swarmHeader([], 0, 97000, undefined, completedSteps(count)))
      .toBe("Swarm · Planning tasks… · 1:37");
  });

  it("shows planning as soon as delegation is recorded, even before tasks arrive", () => {
    const steps: AgentStep[] = [{ id: "delegate", kind: "tool", tool: "delegateTasks", status: "running", startedAt: 0 }];
    expect(swarmHeader([], 0, 97000, swarmSoloReason(steps, true), steps))
      .toBe("Swarm · Planning tasks… · 1:37");
  });

  it("handles singular workers and sub-orchestrators", () => {
    expect(swarmHeader([task("queued"), task("error", "sub-orchestrator")], 0, 59000))
      .toBe("Swarm · 1 lead · 1 worker · 0:59 · 0 done");
    expect(swarmHeader([task("done", "sub-orchestrator"), task("done", "sub-orchestrator"), task("done")], 0, 0))
      .toBe("Swarm · 2 leads · 1 worker · 0:00 · 1 done");
  });

  it("says a finished run built solo, and why, instead of zero workers", () => {
    const call = (fields: Partial<AgentStep>): AgentStep => ({ id: "c", kind: "tool", tool: "delegateTasks", status: "done", startedAt: 0, ...fields });
    expect(swarmSoloReason([call({ targets: ["one-line fix"] })])).toBe("one-line fix");
    expect(swarmSoloReason([call({ status: "error", error: "Error: another swarm is already running for this account; build this one yourself." })]))
      .toBe("another swarm is already running for this account; build this one yourself.");
    expect(swarmSoloReason([])).toBe("the orchestrator did not delegate");
    expect(swarmHeader([], 0, 229000, swarmSoloReason([])))
      .toBe("Swarm · Built solo: the orchestrator did not delegate · 3:49");
    const solo: AgentStep[] = [{ id: "swarm-solo", kind: "thinking", text: "Building solo: a small edit", status: "done", startedAt: 0 }];
    expect(swarmHeader([], 0, 1000, swarmSoloReason(solo, true), solo))
      .toBe("Swarm · Built solo: a small edit · 0:01");
    expect(swarmHeader([], 0, 229000, "one-line fix")).toBe("Swarm · Built solo: one-line fix · 3:49");
    // Workers ran: the counts stay.
    expect(swarmHeader([task("done")], 0, 0, "ignored")).toBe("Swarm · 1 worker · 0:00 · 1 done");
  });

  it("clamps a future start and pads seconds across minute boundaries", () => {
    expect(swarmElapsed(1000, 0)).toBe("0:00");
    expect(swarmElapsed(0, 60000)).toBe("1:00");
    expect(swarmElapsed(0, 3601000)).toBe("60:01");
  });
});

describe("groupSwarmTasks", () => {
  const task = (taskId: string, role: SwarmTask["role"] = "worker", parentTaskId?: string): SwarmTask => ({
    taskId, role, parentTaskId, title: taskId, model: "Haiku 5.5", status: "queued", steps: [], updatedAt: 0,
  });

  it("groups children arriving after other roots under their lead, preserving sibling order", () => {
    const lead = task("lead", "sub-orchestrator");
    const first = task("lead/first", "worker", "lead");
    const second = task("lead/second", "worker", "lead");
    const direct = task("direct");
    expect(groupSwarmTasks([lead, direct, first, second])).toEqual([
      { task: lead, children: [first, second] }, { task: direct, children: [] },
    ]);
  });

  it("keeps orphaned workers visible and handles children arriving before their lead", () => {
    const lead = task("lead", "sub-orchestrator");
    const child = task("child", "worker", "lead");
    const orphan = task("orphan", "worker", "missing");
    expect(groupSwarmTasks([child, orphan, lead])).toEqual([
      { task: orphan, children: [] }, { task: lead, children: [child] },
    ]);
    expect(groupSwarmTasks([])).toEqual([]);
  });
});

describe("swarmSelfCheckStatus", () => {
  it.each([
    ["scoped-ok", "ok"], ["scoped-failed (2 in owned files)", "failed"],
    ["skipped (cost budget)", "skipped"], ["running", "running"],
    [undefined, undefined], ["unknown", undefined],
  ])("labels %s without implying integration verification", (value, expected) => {
    expect(swarmSelfCheckStatus(value)).toBe(expected);
  });
});
