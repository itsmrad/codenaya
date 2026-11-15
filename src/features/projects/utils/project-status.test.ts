import { describe, expect, it } from "vitest";

import { lastRunStatuses } from "./project-status";

describe("lastRunStatuses (#318)", () => {
  it("maps each project's last run to running, failed or done", () => {
    const statuses = lastRunStatuses(
      [
        { projectId: "running", at: 30 },
        { projectId: "failed", at: 10 },
        { projectId: "done", at: 10 },
        { projectId: "cancelled", at: 10 },
      ],
      [
        { projectId: "failed", at: 20, outcome: "error" },
        { projectId: "done", at: 20, outcome: "ok" },
        { projectId: "cancelled", at: 20, outcome: "cancelled" },
      ],
    );
    expect(Object.fromEntries(statuses)).toEqual({
      running: "running",
      failed: "failed",
      done: "done",
    });
  });

  it("uses the newest run, whatever order the events come in", () => {
    const statuses = lastRunStatuses(
      [
        { projectId: "p", at: 10 },
        { projectId: "p", at: 30 },
      ],
      [
        { projectId: "p", at: 40, outcome: "ok" },
        { projectId: "p", at: 20, outcome: "error" },
      ],
    );
    expect(statuses.get("p")).toBe("done");

    // A new run after a failed one is running again.
    const rerun = lastRunStatuses(
      [{ projectId: "p", at: 30 }],
      [{ projectId: "p", at: 20, outcome: "error" }],
    );
    expect(rerun.get("p")).toBe("running");
  });

  it("stays running while an overlapping later run is still going", () => {
    const statuses = lastRunStatuses(
      [
        { projectId: "p", at: 10 },
        { projectId: "p", at: 20 },
      ],
      [{ projectId: "p", at: 30, outcome: "ok" }],
    );
    expect(statuses.get("p")).toBe("running");
  });

  it("gives projects without run events no status", () => {
    expect(lastRunStatuses([], [{ projectId: "p", at: 1, outcome: "ok" }]).size).toBe(0);
  });
});
