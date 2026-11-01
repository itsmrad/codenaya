import { describe, expect, it } from "vitest";

import { BUILD_CHECK_NUDGE, createBuildCheckGate, hasUncheckedWrites } from "./build-check-gate";

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

describe("createBuildCheckGate", () => {
  it("routes back once, with the note for that turn only", () => {
    const gate = createBuildCheckGate();
    const results = [turn(call("createFiles")), turn()];

    expect(gate.takeNudge()).toBeUndefined();
    expect(gate.shouldContinue(results)).toBe(true);
    expect(gate.takeNudge()).toBe(BUILD_CHECK_NUDGE);
    expect(gate.takeNudge()).toBeUndefined();

    // The agent ignored the note and wrote again: the run still ends.
    expect(gate.shouldContinue([...results, turn(call("updateFile")), turn()])).toBe(false);
    expect(gate.takeNudge()).toBeUndefined();
  });

  it("lets a run without unchecked writes end", () => {
    expect(createBuildCheckGate().shouldContinue([turn(call("listFiles")), turn()])).toBe(false);
  });
});
