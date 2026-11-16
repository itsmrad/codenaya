import { describe, expect, it } from "vitest";

import {
  type AgentStep,
  BUILD_CHECK_UNFINISHED,
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  STATIC_CHECKS_PASSED,
  LOST_RUN_MESSAGE,
  stepsFromToolResults,
} from "./agent-steps";
import { AGENT_FAILURE_MESSAGE } from "./failed-run-reply";
import { runVerdict } from "./run-verdict";

const write = (status: AgentStep["status"] = "done", targets = ["src/App.tsx"]): AgentStep => ({
  id: "write", kind: "tool", tool: "updateFile", status, targets, startedAt: 0,
});
const check = (status: AgentStep["status"], text?: string, error?: string): AgentStep => ({
  id: "check", kind: "tool", tool: "checkBuild", status, text, error, startedAt: 1,
});
const verdict = (...steps: AgentStep[]) => runVerdict({ status: "completed", steps });

describe("runVerdict", () => {
  it("requires a full build pass after the last write", () => {
    expect(verdict(write(), check("done", BUILD_VERIFIED))).toBe("verified");
    expect(verdict(check("done", BUILD_VERIFIED), write())).toBe("unverified");
    expect(verdict(write(), check("done", BUILD_VERIFIED), write("running"))).toBe("unverified");
  });

  it("does not treat static checks, skipped checks or unavailable checks as verification", () => {
    expect(verdict(write())).toBe("unverified");
    expect(verdict(write(), check("done", STATIC_CHECKS_PASSED))).toBe("unverified");
    expect(verdict(write(), check("done", BUILD_NOT_CHECKED))).toBe("unverified");
    expect(verdict(write(), check("error", undefined, BUILD_CHECK_UNFINISHED))).toBe("unverified");
    expect(verdict(write(), check("done", BUILD_VERIFIED), check("done", STATIC_CHECKS_PASSED))).toBe("unverified");
  });

  it("reports no changes only when recorded steps establish it", () => {
    expect(verdict()).toBe("no-changes");
    expect(verdict(check("done", BUILD_VERIFIED))).toBe("no-changes");
    expect(runVerdict({})).toBeNull();
    expect(runVerdict({ steps: undefined })).toBeNull();
  });

  it("prioritizes failed replies over earlier successful writes and checks", () => {
    for (const content of [AGENT_FAILURE_MESSAGE, LOST_RUN_MESSAGE]) {
      expect(runVerdict({
        status: "completed", content, steps: [write(), check("done", BUILD_VERIFIED)],
      })).toBe("errors");
      expect(runVerdict({ content })).toBe("errors");
    }
  });

  it("preserves partial batch failures through tool-result recording", () => {
    const [result] = stepsFromToolResults([{
      type: "tool_result", role: "tool_result", stop_reason: "tool",
      tool: { type: "tool", id: "batch", name: "writeFiles", input: {} },
      content: { data: "Wrote 1 file(s). Created: a.ts. Failed: b.ts (locked)." },
    }], 1);
    const batch = { ...result, targets: ["a.ts", "b.ts"] };
    expect(batch.status).toBe("done");
    expect(batch.error).toContain("Failed: b.ts");
    expect(verdict(batch, check("done", BUILD_VERIFIED))).toBe("errors");
    expect(verdict(batch, write("done", ["a.ts", "b.ts"]), check("done", BUILD_VERIFIED))).toBe("verified");
    expect(verdict({ ...write(), tool: "writeFiles", error: "Failed: b.ts (locked)." }, check("done", BUILD_VERIFIED))).toBe("errors");
  });

  it("counts deletions, renames and every target in a batch as changes", () => {
    for (const tool of ["deleteFiles", "renameFile", "writeFiles"]) {
      expect(verdict({ ...write(), tool, targets: ["a.ts", "b.ts"] })).toBe("unverified");
    }
  });

  it("prioritizes unresolved errors over no changes or a passing build", () => {
    expect(verdict(write("error"))).toBe("errors");
    expect(verdict(write(), check("done", BUILD_VERIFIED), write("error", ["other.ts"]))).toBe("errors");
    expect(verdict(write(), check("error", undefined, "Error: Build failed."))).toBe("errors");
  });

  it("clears a failed write only after a successful rewrite of the same path", () => {
    expect(verdict(write("error"), write())).toBe("unverified");
    expect(verdict(write("error"), { ...write(), tool: "writeFiles" }, check("done", BUILD_VERIFIED))).toBe("verified");
    expect(verdict(write("error"), write("done", ["other.ts"]))).toBe("errors");
    expect(verdict(write("error", ["a.ts", "b.ts"]), write("done", ["a.ts"]))).toBe("errors");
  });

  it("reuses build-error resolution without hiding a later failed build", () => {
    const failed = check("error", undefined, "Error: Build failed.");
    expect(verdict(failed, write(), check("done", BUILD_VERIFIED))).toBe("verified");
    expect(verdict(failed, write(), check("done", STATIC_CHECKS_PASSED))).toBe("errors");
    expect(verdict(check("error", undefined, STATIC_CHECKS_FAILED), write(), check("done", STATIC_CHECKS_PASSED))).toBe("unverified");
    expect(verdict(write(), check("done", BUILD_VERIFIED), failed)).toBe("errors");
  });

  it("clears a non-file tool error when the same call succeeds", () => {
    const read = { ...write("error"), tool: "readFiles" };
    expect(verdict(read)).toBe("errors");
    expect(verdict(read, { ...read, status: "done" })).toBe("no-changes");
  });

  it("does not call a stuck run verified", () => {
    expect(runVerdict({
      steps: [write(), check("done", BUILD_VERIFIED)],
      stuck: { reason: "repeated-write", path: "src/App.tsx" },
    })).toBe("unverified");
  });

  it("hides verdicts for active, cancelled, plan and swarm runs", () => {
    for (const status of ["processing", "cancelled"] as const) {
      expect(runVerdict({ status, steps: [write(), check("done", BUILD_VERIFIED)] })).toBeNull();
    }
    for (const mode of ["plan", "swarm"] as const) {
      expect(runVerdict({ mode, steps: [write()] })).toBeNull();
    }
  });
});
