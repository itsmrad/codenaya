import { describe, expect, it } from "vitest";
import { needsRunEndReload } from "./run-end-reload";

describe("needsRunEndReload (#774)", () => {
  it("folds a checked first build into its existing end reload", () => {
    expect(needsRunEndReload(true, [{ tool: "checkBuild", status: "done" }])).toBe(true);
    expect(needsRunEndReload(true, [])).toBe(true);
  });

  it("reloads after a checked repair, including one without a file diff", () => {
    expect(needsRunEndReload(false, [
      { tool: "checkBuild", status: "error" },
      { tool: "editFile", status: "done" },
      { tool: "checkBuild", status: "done" },
    ])).toBe(true);
    expect(needsRunEndReload(false, [{ tool: "checkBuild", status: "done" }])).toBe(true);
  });

  it("does not reload chat-only follow-ups or ordinary edits without a build check", () => {
    expect(needsRunEndReload(false, [])).toBe(false);
    expect(needsRunEndReload(false, [{ tool: "editFile", status: "done" }])).toBe(false);
  });

  it("also covers failed checks and a final check update lost when activeRun becomes null", () => {
    expect(needsRunEndReload(false, [{ tool: "checkBuild", status: "error" }])).toBe(true);
    expect(needsRunEndReload(false, [{ tool: "checkBuild", status: "running" }])).toBe(true);
    expect(needsRunEndReload(false, [
      { tool: "checkBuild", status: "done" },
      { tool: "checkBuild", status: "error" },
    ])).toBe(true);
  });
});
