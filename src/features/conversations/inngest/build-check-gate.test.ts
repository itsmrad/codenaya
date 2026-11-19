import { describe, expect, it } from "vitest";

import {
  BUILD_CHECK_NUDGE,
  BUILD_FAILED_NOTE,
  BUILD_NOT_BUILT_NOTE,
  BUILD_REPAIR_NUDGE,
  BUILD_RESERVE_NUDGE,
  BUILD_RETRY_NUDGE,
  BUILD_UNVERIFIED_NOTE,
  createBuildCheckGate,
  hasUncheckedWrites,
  MAX_BUILD_CHECKS,
  needsBuildRepair,
  unverifiedBuildNote,
} from "./build-check-gate";
import { OUTPUT_LIMIT_ERROR } from "./lib/output-limit";
import { brokenImagesError } from "./tools/remote-images";

const call = (name: string, data = "ok") => ({ tool: { name }, content: { data } });
const turn = (...toolCalls: ReturnType<typeof call>[]) => ({ toolCalls });
const failedCheck = () => call("checkBuild", "Error: Build failed.");
const unfinishedCheck = () => call("checkBuild", "Error: The build check could not finish (deadline_exceeded).");

describe("needsBuildRepair", () => {
  it("is true only for writes that ended on a failed check or none", () => {
    const verified = call("checkBuild", "Build verified\nDependencies installed.");
    const notBuilt = call("checkBuild", "Build not checked\nStatic checks passed.");
    expect(needsBuildRepair([turn(call("createFiles"), failedCheck())])).toBe(true);
    expect(needsBuildRepair([turn(call("createFiles"))])).toBe(true);
    expect(needsBuildRepair([turn(call("createFiles"), verified)])).toBe(false);
    expect(needsBuildRepair([turn(call("createFiles"), notBuilt)])).toBe(false);
    expect(needsBuildRepair([turn(call("createFiles"), unfinishedCheck())])).toBe(false);
    expect(needsBuildRepair([turn(call("readFiles"), failedCheck())])).toBe(false);
  });
});

describe("broken images from checkBuild", () => {
  it("get a repair turn like a failed build", () => {
    const brokenImages = call("checkBuild", brokenImagesError(["src/App.tsx: https://images.unsplash.com/photo-1 (HTTP 404)"]));
    const gate = createBuildCheckGate();
    expect(gate.shouldContinue([turn(call("createFiles"), brokenImages)])).toBe(true);
    expect(gate.takeNudge()).toBe(BUILD_REPAIR_NUDGE);
    expect(needsBuildRepair([turn(call("createFiles"), brokenImages)])).toBe(true);
  });
});

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

  it("is false after a check that could not run, which only the gate retries", () => {
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

  it("retries a check that could not finish once, then a verified check ends the run", () => {
    const gate = createBuildCheckGate();
    const timedOut = [turn(call("createFiles")), turn(unfinishedCheck()), turn()];

    expect(gate.shouldContinue(timedOut)).toBe(true);
    expect(gate.takeNudge()).toBe(BUILD_RETRY_NUDGE);
    expect(gate.repairs).toBe(0);
    expect(gate.shouldContinue([...timedOut, turn(call("checkBuild", "Build verified")), turn()])).toBe(false);
    expect(unverifiedBuildNote([...timedOut, turn(call("checkBuild", "Build verified"))])).toBeUndefined();
  });

  it("does not retry a second check that could not finish", () => {
    const gate = createBuildCheckGate();
    const timedOut = [turn(call("createFiles")), turn(unfinishedCheck()), turn()];

    expect(gate.shouldContinue(timedOut)).toBe(true);
    gate.takeNudge();
    const twice = [...timedOut, turn(unfinishedCheck()), turn()];
    expect(gate.shouldContinue(twice)).toBe(false);
    expect(gate.takeNudge()).toBeUndefined();
    expect(unverifiedBuildNote(twice)).toBe(BUILD_UNVERIFIED_NOTE);
  });

  it("still repairs a failed check after the retry", () => {
    const gate = createBuildCheckGate();
    const timedOut = [turn(call("createFiles")), turn(unfinishedCheck()), turn()];

    expect(gate.shouldContinue(timedOut)).toBe(true);
    expect(gate.takeNudge()).toBe(BUILD_RETRY_NUDGE);
    expect(gate.shouldContinue([...timedOut, turn(failedCheck()), turn()])).toBe(true);
    expect(gate.takeNudge()).toBe(BUILD_REPAIR_NUDGE);
    expect(gate.repairs).toBe(1);
  });

  it("does not retry an unfinished check once the check budget is spent", () => {
    const spent = [
      turn(call("createFiles"), failedCheck()),
      turn(call("updateFile"), failedCheck()),
      turn(call("updateFile"), unfinishedCheck()),
      turn(),
    ];
    const gate = createBuildCheckGate();
    expect(gate.shouldContinue(spent)).toBe(false);
    expect(gate.takeNudge()).toBeUndefined();
  });

  it("does not retry an unfinished check once the forced turns are spent", () => {
    const gate = createBuildCheckGate();
    // The agent answers every note with text and never checks.
    const unchecked = [turn(call("createFiles")), turn()];
    for (let attempt = 1; attempt <= MAX_BUILD_CHECKS; attempt += 1) {
      expect(gate.shouldContinue(unchecked)).toBe(true);
      gate.takeNudge();
    }
    expect(gate.shouldContinue([turn(call("createFiles")), turn(unfinishedCheck()), turn()])).toBe(false);
    expect(gate.takeNudge()).toBeUndefined();
  });

  it("leaves an unfinished check to the retry, not the step-budget reminder", () => {
    const gate = createBuildCheckGate();
    const timedOut = [turn(call("createFiles")), turn(unfinishedCheck())];
    gate.reserve(timedOut);
    expect(gate.takeNudge()).toBeUndefined();

    expect(gate.shouldContinue([...timedOut, turn()])).toBe(true);
    expect(gate.takeNudge()).toBe(BUILD_RETRY_NUDGE);
    // The retry does not use up the reminder: a later write still gets it, once.
    gate.reserve([...timedOut, turn(call("updateFile"))]);
    expect(gate.takeNudge()).toBe(BUILD_RESERVE_NUDGE);
    gate.reserve([...timedOut, turn(call("updateFile")), turn(call("updateFile"))]);
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
