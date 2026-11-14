import { describe, expect, it } from "vitest";

import {
  BUILD_CHECK_NUDGE,
  BUILD_FAILED_NOTE,
  BUILD_NOT_BUILT_NOTE,
  BUILD_REPAIR_NUDGE,
  BUILD_RESERVE_NUDGE,
  BUILD_UNVERIFIED_NOTE,
  createBuildCheckGate,
  hasUncheckedWrites,
  MAX_BUILD_CHECKS,
  unverifiedBuildNote,
} from "./build-check-gate";
import { OUTPUT_LIMIT_ERROR } from "./lib/output-limit";

const call = (name: string, data = "ok") => ({ tool: { name }, content: { data } });
const turn = (...toolCalls: ReturnType<typeof call>[]) => ({ toolCalls });
const failedCheck = () => call("checkBuild", "Error: Build failed.");

describe("hasUncheckedWrites", () => {
  it("is false for a run that wrote nothing", () => {
    expect(hasUncheckedWrites([turn(call("listFiles"), call("readFiles")), turn()])).toBe(false);
  });

  it("is true after a write with no check", () => {
    expect(hasUncheckedWrites([turn(call("createFiles")), turn()])).toBe(true);
  });

  it("ignores failed single-mutation writes, returned or thrown", () => {
    const thrown = { tool: { name: "renameFile" }, content: { error: { message: "boom" } } };
    expect(hasUncheckedWrites([turn(call("editFile", "Error: oldText #1 matched 0 times")), turn()])).toBe(false);
    expect(hasUncheckedWrites([turn(call("updateFile", "Error: \"src\" is a folder")), turn()])).toBe(false);
    expect(hasUncheckedWrites([{ toolCalls: [thrown] }, turn()])).toBe(false);
  });

  it("counts failed multi-mutation writes, which may have written some files first", () => {
    // writeFiles wrote a.ts, then b.ts threw.
    expect(hasUncheckedWrites([turn(call("writeFiles", "Error writing files: fetch failed")), turn()])).toBe(true);
    expect(hasUncheckedWrites([turn(call("deleteFiles", "Error deleting files: fetch failed")), turn()])).toBe(true);
  });

  it("is false once a check passes after the last write", () => {
    expect(hasUncheckedWrites([turn(call("updateFile")), turn(call("checkBuild", "Build verified"))])).toBe(false);
  });

  it("is true for a write after a passing check, or a failed check", () => {
    expect(hasUncheckedWrites([turn(call("checkBuild", "Build verified")), turn(call("deleteFiles"))])).toBe(true);
    expect(hasUncheckedWrites([turn(call("scaffoldViteApp")), turn(failedCheck())])).toBe(true);
  });

  it("is false after a check that could not run, which the agent reports instead", () => {
    const unfinished = call(
      "checkBuild",
      "Error: The build check could not finish (Command timed out). This is not an error in the project's code.",
    );
    expect(hasUncheckedWrites([turn(call("updateFile")), turn(unfinished)])).toBe(false);
  });

  it("is true for a check that failed again with no write since", () => {
    expect(hasUncheckedWrites([turn(call("updateFile")), turn(call("checkBuild", "Build verified")), turn(failedCheck())])).toBe(true);
  });

  it("ignores a cut-off write that was refused", () => {
    expect(hasUncheckedWrites([turn(call("writeFiles", OUTPUT_LIMIT_ERROR)), turn()])).toBe(false);
  });

  it("is false once the check and both fix attempts are spent", () => {
    expect(
      hasUncheckedWrites([
        turn(call("updateFile"), failedCheck()),
        turn(call("updateFile"), failedCheck()),
        turn(call("updateFile"), failedCheck()),
      ]),
    ).toBe(false);
  });
});

describe("unverifiedBuildNote", () => {
  it("is undefined when nothing was written or the last check passed", () => {
    expect(unverifiedBuildNote([turn(call("listFiles")), turn(failedCheck())])).toBeUndefined();
    expect(unverifiedBuildNote([turn(call("createFiles"), failedCheck()), turn(call("checkBuild", "Build verified"))])).toBeUndefined();
  });

  it("names a build that still fails", () => {
    expect(unverifiedBuildNote([turn(call("createFiles")), turn(failedCheck())])).toBe(BUILD_FAILED_NOTE);
  });

  it("names changes whose check passed without building them", () => {
    const writes = turn(call("createFiles"));
    const staticOnly = call("checkBuild", "Static checks passed\nNo build sandbox is configured, so the type check and build did not run.");
    const noSandbox = call("checkBuild", "Static checks passed\nThe build sandbox could not start, so the type check and build did not run.");
    const notVite = call("checkBuild", "Build not checked\nStatic checks passed. checkBuild only builds Vite projects, so this one was not built.");
    const noResult = { tool: { name: "checkBuild" }, content: undefined };
    for (const check of [staticOnly, noSandbox, notVite, noResult]) {
      expect(unverifiedBuildNote([writes, { toolCalls: [check] }])).toBe(BUILD_NOT_BUILT_NOTE);
      // Nothing to fix: the gate does not route back for another check.
      expect(hasUncheckedWrites([writes, { toolCalls: [check] }, turn()])).toBe(false);
    }
  });

  it("names changes that were never checked, or whose check could not run", () => {
    const unfinished = call("checkBuild", "Error: The build check could not finish (Command timed out).");
    expect(unverifiedBuildNote([turn(call("createFiles"))])).toBe(BUILD_UNVERIFIED_NOTE);
    expect(unverifiedBuildNote([turn(call("checkBuild", "Build verified")), turn(call("editFile"))])).toBe(BUILD_UNVERIFIED_NOTE);
    expect(unverifiedBuildNote([turn(call("createFiles")), turn(unfinished)])).toBe(BUILD_UNVERIFIED_NOTE);
  });
});

describe("createBuildCheckGate", () => {
  it("routes back with the note for that turn only", () => {
    const gate = createBuildCheckGate();
    const results = [turn(call("createFiles")), turn()];

    expect(gate.takeNudge()).toBeUndefined();
    expect(gate.shouldContinue(results)).toBe(true);
    // A check turn is not a repair.
    expect(gate.repairs).toBe(0);
    expect(gate.takeNudge()).toBe(BUILD_CHECK_NUDGE);
    expect(gate.takeNudge()).toBeUndefined();
  });

  it("asks for a fix after a failed check, and stops after MAX_BUILD_CHECKS forced turns", () => {
    const gate = createBuildCheckGate();
    // The agent answers every note with text and never checks again.
    const results = [turn(call("createFiles"), failedCheck()), turn()];

    for (let attempt = 1; attempt <= MAX_BUILD_CHECKS; attempt += 1) {
      expect(gate.shouldContinue(results)).toBe(true);
      expect(gate.takeNudge()).toBe(BUILD_REPAIR_NUDGE);
      expect(gate.repairs).toBe(attempt);
    }
    expect(gate.shouldContinue(results)).toBe(false);
    expect(gate.takeNudge()).toBeUndefined();
  });

  it("asks once for the check when the step budget runs low", () => {
    const gate = createBuildCheckGate();
    gate.reserve([turn(call("listFiles"))]);
    expect(gate.takeNudge()).toBeUndefined();

    gate.reserve([turn(call("createFiles"))]);
    expect(gate.takeNudge()).toBe(BUILD_RESERVE_NUDGE);
    gate.reserve([turn(call("createFiles")), turn(call("updateFile"))]);
    expect(gate.takeNudge()).toBeUndefined();
  });

  it("lets a run without unchecked writes end", () => {
    expect(createBuildCheckGate().shouldContinue([turn(call("listFiles")), turn()])).toBe(false);
  });
});
