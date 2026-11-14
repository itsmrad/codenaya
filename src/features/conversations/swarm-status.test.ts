import { describe, expect, it } from "vitest";

import { type SwarmTask, swarmElapsed, swarmHeader, swarmTaskStatus } from "./swarm-status";

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
    expect(swarmHeader([task("done"), task("done"), task("running")], 1000, 135000))
      .toBe("Swarm · 3 workers · 2:14 · 2 done");
  });

  it("handles zero workers, singular workers and sub-orchestrators", () => {
    expect(swarmHeader([], 0, 0)).toBe("Swarm · 0 workers · 0:00 · 0 done");
    expect(swarmHeader([task("queued"), task("error", "sub-orchestrator")], 0, 59000))
      .toBe("Swarm · 1 worker · 0:59 · 0 done");
  });

  it("clamps a future start and pads seconds across minute boundaries", () => {
    expect(swarmElapsed(1000, 0)).toBe("0:00");
    expect(swarmElapsed(0, 60000)).toBe("1:00");
    expect(swarmElapsed(0, 3601000)).toBe("60:01");
  });
});
