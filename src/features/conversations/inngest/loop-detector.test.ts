import { describe, expect, it } from "vitest";

import {
  PREVIOUS_ERROR_HINT,
  createLoopGuard,
  detectLoop,
  errorSignature,
} from "./loop-detector";
import { BUILD_CHECK_UNFINISHED } from "../agent-steps";
import { SYNTAX_ERRORS_NOTE } from "./tools/syntax-error";

const ID_A = "k57b9c2xq1m4n8p0r3s6t9v2w5y8z1ab";
const ID_B = "j8a2c4e6g8i0k2m4o6q8s0u2w4y6a8c0";

let ids = 0;
const call = (name: string, data: string, input: Record<string, unknown> = {}) => {
  const id = `call_${++ids}`;
  return {
    output: [{ type: "tool_call", tools: [{ id, input }] }],
    toolCalls: [{ tool: { id, name }, content: { data } }],
  };
};
// Legacy id-addressed updateFile calls; the result names the file's path, as since #292.
const PATHS: Record<string, string> = { [ID_A]: "src/a/App.tsx", [ID_B]: "src/b/App.tsx" };
const write = (fileId: string, note = "") =>
  call("updateFile", `File "${PATHS[fileId]}" updated successfully${note}`, { fileId });
const syntaxNote = (entries: string) => `\n${SYNTAX_ERRORS_NOTE}${entries}`;
const times = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

describe("detectLoop", () => {
  it("trips on the same tool error three times, not twice", () => {
    const error = () => call("readFiles", 'Error: File with ID "missing" not found.');
    expect(detectLoop(times(2, error))).toBeNull();
    expect(detectLoop(times(3, error))).toMatchObject({
      reason: "repeated-error",
      error: 'Error: File with ID "missing" not found.',
    });
  });

  it("treats errors that differ only in ids and line numbers as one", () => {
    const results = [
      call("updateFile", `Error: File with ID "${ID_A}" not found at line 12.`, { fileId: ID_A }),
      call("updateFile", `Error: File with ID "${ID_B}" not found at line 40.`, { fileId: ID_B }),
      call("updateFile", `Error: File with ID "${ID_A}" not found at line 7.`, { fileId: ID_A }),
    ];
    expect(detectLoop(results)).toMatchObject({ reason: "repeated-error", fileId: ID_A });
  });

  it("keeps different errors apart", () => {
    const results = ["missing", "a folder", "too large"].map((what) =>
      call("updateFile", `Error: "src" is ${what}.`),
    );
    expect(detectLoop([...results, ...results.slice(0, 2)])).toBeNull();
  });

  // Build failures that differ, so only the write rule can trip.
  const failedBuild = (what: string) => call("checkBuild", `Error: Build failed: ${what} is not defined`);
  const passedBuild = () => call("checkBuild", "Build verified\nvite build finished");
  const unfinished = () =>
    call("checkBuild", `${BUILD_CHECK_UNFINISHED} (sandbox timed out). Report it to the user.`);

  it("lets a healthy run rewrite a hub file as often as it needs", () => {
    expect(detectLoop(times(6, () => write(ID_A)))).toBeNull();
    expect(detectLoop(times(4, () => [write(ID_A), passedBuild()]).flat())).toBeNull();
  });

  it("trips when one file is rewritten four times, each after a failure", () => {
    const rounds = ["alpha", "beta", "gamma"].flatMap((what) => [write(ID_A), failedBuild(what)]);
    expect(detectLoop(rounds)).toBeNull();
    expect(detectLoop([...rounds, write(ID_A)])).toEqual({ reason: "repeated-write", path: PATHS[ID_A] });
  });

  it("trips on path-based rewrites by updateFile, writeFiles or both (#292)", () => {
    const update = () => call("updateFile", 'File "src/App.tsx" updated successfully', { path: "./src/App.tsx" });
    const writeAll = () =>
      call("writeFiles", "Wrote 2 file(s). Updated: src/App.tsx, src/main.tsx.", {
        files: [{ path: "src/App.tsx" }, { path: "src/main.tsx" }],
      });
    const failures = ["alpha", "beta", "gamma"].map(failedBuild);
    const rounds = (rewrite: (i: number) => ReturnType<typeof call>) => [
      ...failures.flatMap((failure, i) => [rewrite(i), failure]),
      rewrite(3),
    ];
    const stuck = { reason: "repeated-write", path: "src/App.tsx" };
    expect(detectLoop(rounds(update))).toEqual(stuck);
    expect(detectLoop(rounds(writeAll))).toEqual(stuck);
    expect(detectLoop(rounds((i) => (i % 2 ? update() : writeAll())))).toEqual(stuck);
    // Healthy path rewrites still don't trip.
    expect(detectLoop(times(6, update))).toBeNull();
  });

  it("counts editFile with updateFile and writeFiles on the same path (#291)", () => {
    const edit = () => call("editFile", 'File "src/App.tsx" edited successfully', { path: "src/App.tsx" });
    const update = () => call("updateFile", 'File "src/App.tsx" updated successfully', { path: "src/App.tsx" });
    const writeAll = () =>
      call("writeFiles", "Wrote 1 file(s). Updated: src/App.tsx.", { files: [{ path: "./src/App.tsx" }] });
    const stuck = { reason: "repeated-write", path: "src/App.tsx" };
    const failures = ["alpha", "beta", "gamma"].map(failedBuild);
    // editFile alone, then all three tools on the one path.
    expect(detectLoop([...failures.flatMap((failure) => [edit(), failure]), edit()])).toEqual(stuck);
    const mixed = [edit, update, writeAll];
    expect(detectLoop([...failures.flatMap((failure, i) => [mixed[i](), failure]), edit()])).toEqual(stuck);
    const broken = () =>
      call("editFile", `File "src/App.tsx" edited successfully${syntaxNote("src/App.tsx 1:1 ')' expected.")}`, {
        path: "src/App.tsx",
      });
    expect(detectLoop([broken(), broken(), broken()])).toMatchObject({
      reason: "repeated-syntax-error",
      path: "src/App.tsx",
    });
  });

  it("attributes a syntax note to the longest path it starts with", () => {
    // "src/x.ts y.ts" (a space in the name) also starts with "src/x.ts ".
    const broken = (line: number) =>
      call(
        "writeFiles",
        `Wrote 2 file(s). Updated: src/x.ts, src/x.ts y.ts.${syntaxNote(`src/x.ts y.ts ${line}:1 ')' expected.`)}`,
        { files: [{ path: "src/x.ts" }, { path: "src/x.ts y.ts" }] },
      );
    expect(detectLoop([broken(1), broken(2), broken(3)])).toMatchObject({
      reason: "repeated-syntax-error",
      path: "src/x.ts y.ts",
    });
  });

  it("splits writeFiles syntax notes by the paths it wrote", () => {
    const broken = (line: number) =>
      call(
        "writeFiles",
        `Wrote 2 file(s). Updated: src/a.tsx, src/b.tsx.${syntaxNote(`src/a.tsx 1:1 Expected ';'; src/b.tsx ${line}:1 ')' expected.`)}`,
        { files: [{ path: "src/a.tsx" }, { path: "src/b.tsx" }] },
      );
    expect(detectLoop([broken(1), broken(2)])).toBeNull();
    expect(detectLoop([broken(1), broken(2), broken(3)])).toMatchObject({
      reason: "repeated-syntax-error",
      path: "src/a.tsx",
      error: "src/a.tsx 1:1 Expected ';'",
    });
  });

  it("counts one file addressed by id, then path, then id again as one file (#292)", () => {
    const byId = () => write(ID_A, syntaxNote(`${PATHS[ID_A]} 1:5 ')' expected.`));
    const byPathCall = call(
      "updateFile",
      `File "${PATHS[ID_A]}" updated successfully${syntaxNote(`${PATHS[ID_A]} 2:5 ')' expected.`)}`,
      { path: PATHS[ID_A] },
    );
    expect(detectLoop([byId(), byPathCall, byId()])).toMatchObject({
      reason: "repeated-syntax-error",
      path: PATHS[ID_A],
    });
  });

  it("counts and resets only the paths a partial writeFiles actually wrote", () => {
    const broken = () =>
      call("writeFiles", `Wrote 1 file(s). Updated: src/a.tsx.${syntaxNote("src/a.tsx 1:1 ')' expected.")}`, {
        files: [{ path: "src/a.tsx" }],
      });
    // src/a.tsx failed here, so its syntax count must survive the batch.
    const partial = call(
      "writeFiles",
      "Wrote 1 file(s). Created: src/b.tsx. Failed: src/a.tsx (a folder; write to a file path inside it).",
      { files: [{ path: "src/a.tsx" }, { path: "src/b.tsx" }] },
    );
    expect(detectLoop([broken(), broken(), partial])).toBeNull();
    expect(detectLoop([broken(), broken(), partial, broken()])).toMatchObject({
      reason: "repeated-syntax-error",
      path: "src/a.tsx",
    });
  });

  it("starts a file's count over after a passing build check", () => {
    const rounds = ["alpha", "beta"].flatMap((what) => [write(ID_A), failedBuild(what)]);
    expect(detectLoop([...rounds, passedBuild(), ...rounds, write(ID_A)])).toBeNull();
  });

  it("keeps counting syntax errors across checks that verify no syntax", () => {
    const broken = () => write(ID_A, syntaxNote("App.tsx 1:5 ')' expected."));
    const staticOnly = () => call("checkBuild", "Static checks passed\nNo sandbox, so the type check and build did not run.");
    const notChecked = () => call("checkBuild", "Build not checked\nStatic checks passed.");
    for (const check of [staticOnly, notChecked]) {
      expect(detectLoop([broken(), check(), broken(), check()])).toBeNull();
      expect(detectLoop([broken(), check(), broken(), check(), broken()])).toMatchObject({
        reason: "repeated-syntax-error",
      });
    }
  });

  it("clears only the rewritten file's syntax count on a clean rewrite", () => {
    const broken = (fileId: string) => write(fileId, syntaxNote("index.tsx 1:5 ')' expected."));
    // A was fixed in between, B never was.
    const results = [broken(ID_A), broken(ID_B), broken(ID_A), broken(ID_B), write(ID_A), broken(ID_A)];
    expect(detectLoop(results)).toBeNull();
    expect(detectLoop([...results, broken(ID_B)])).toMatchObject({
      reason: "repeated-syntax-error",
      path: PATHS[ID_B],
    });
  });

  it("starts syntax error counts over after a passing build check", () => {
    const broken = write(ID_A, syntaxNote("App.tsx 1:5 ')' expected."));
    const round = () => [broken, write(ID_A), passedBuild()];
    expect(detectLoop([...round(), ...round(), broken])).toBeNull();
    // With static-only checks, the repairing rewrite is what clears it.
    const staticRound = () => [broken, write(ID_A), call("checkBuild", "Static checks passed\nNo sandbox.")];
    expect(detectLoop([...staticRound(), ...staticRound(), broken])).toBeNull();
    expect(detectLoop([...round(), broken, broken, broken])).toMatchObject({
      reason: "repeated-syntax-error",
    });
  });

  it("keeps counting repeated errors across static-only checks", () => {
    const notFound = () => call("readFiles", 'Error: File with ID "missing" not found.');
    const staticOnly = () => call("checkBuild", "Static checks passed\nNo sandbox.");
    expect(detectLoop([notFound(), staticOnly(), notFound(), staticOnly(), notFound()])).toMatchObject({
      reason: "repeated-error",
    });
  });

  it("starts repeated error counts over after a passing build check", () => {
    const notFound = () => call("readFiles", 'Error: File with ID "missing" not found.');
    const round = () => [notFound(), notFound(), passedBuild()];
    expect(detectLoop([...round(), ...round(), notFound()])).toBeNull();
    expect(detectLoop([...round(), notFound(), notFound(), notFound()])).toMatchObject({
      reason: "repeated-error",
    });
  });

  it("counts writes per file, and not failed writes", () => {
    const rounds = ["alpha", "beta", "gamma", "delta"].flatMap((what, i) => [
      write(i % 2 ? ID_A : ID_B),
      failedBuild(what),
    ]);
    expect(detectLoop(rounds)).toBeNull();
    const failed = call("updateFile", "Error update file: conflict", { fileId: ID_A });
    expect(detectLoop([failed, failedBuild("alpha"), failed, failedBuild("beta"), write(ID_A)])).toBeNull();
  });

  it("counts a turn's parallel calls one by one", () => {
    const calls = [
      ...["alpha", "beta", "gamma"].flatMap((what) => [write(ID_A), failedBuild(what)]),
      write(ID_A),
    ];
    const turn = {
      output: calls.flatMap((c) => c.output),
      toolCalls: calls.flatMap((c) => c.toolCalls),
    };
    expect(detectLoop([turn])).toMatchObject({ reason: "repeated-write" });
  });

  it("ignores build checks that could not run", () => {
    expect(detectLoop(times(5, unfinished))).toBeNull();
    // Nor do they count as a failure after a write.
    expect(detectLoop(times(5, () => [write(ID_A), unfinished()]).flat())).toBeNull();
  });

  it("trips when one file fails to parse three times", () => {
    const broken = (line: number) =>
      write(ID_A, syntaxNote(`App.tsx ${line}:5 ')' expected.`));
    expect(detectLoop([broken(3), broken(9)])).toBeNull();
    expect(detectLoop([broken(3), broken(9), broken(14)])).toMatchObject({
      reason: "repeated-syntax-error",
      path: PATHS[ID_A],
      error: "App.tsx 14:5 ')' expected.",
      signature: errorSignature("App.tsx 1:5 ')' expected."),
    });
  });

  it("keys syntax errors by file id, so two files with one name stay apart", () => {
    const broken = (fileId: string) => write(fileId, syntaxNote("index.tsx 1:1 ')' expected."));
    expect(detectLoop([broken(ID_A), broken(ID_B), broken(ID_A), broken(ID_B)])).toBeNull();
  });

  it("keeps a message with '; ' in it whole", () => {
    const entry = "App.tsx 2:1 Unexpected token; did you mean '}'? x 3:1";
    const result = detectLoop(times(3, () => write(ID_A, syntaxNote(entry))));
    expect(result).toMatchObject({ reason: "repeated-syntax-error", error: entry });
  });

  it("splits createFiles notes only before a file it wrote", () => {
    const created = (i: number) =>
      call(
        "createFiles",
        `Created 2 file(s): a.tsx, b.tsx${syntaxNote(`a.tsx 1:1 Expected ';'; b.tsx ${i}:1 ')' expected.`)}`,
        { parentId: "", files: [{ name: "a.tsx" }, { name: "b.tsx" }] },
      );
    expect(detectLoop([created(1), created(2)])).toBeNull();
    expect(detectLoop([created(1), created(2), created(3)])).toMatchObject({
      reason: "repeated-syntax-error",
      error: "a.tsx 1:1 Expected ';'",
    });
  });

  it("keeps syntax errors in different files apart", () => {
    const results = times(4, (i) =>
      call("createFiles", `Created 1 file${syntaxNote(`${i}.tsx 1:1 ')' expected.`)}`, {
        parentId: "",
        files: [{ name: `${i}.tsx` }],
      }),
    );
    expect(detectLoop(results)).toBeNull();
  });
});

describe("createLoopGuard", () => {
  const notFound = call("readFiles", `Error: File with ID "${ID_A}" not found.`);

  it("hints once when the run repeats the previous run's error", () => {
    const guard = createLoopGuard(errorSignature(`Error: File with ID "${ID_B}" not found.`));
    expect(guard.check([notFound])).toBeNull();
    expect(guard.takeHint()).toBe(PREVIOUS_ERROR_HINT);
    expect(guard.takeHint()).toBeUndefined();
    guard.check([notFound, notFound]);
    expect(guard.takeHint()).toBeUndefined();
  });

  it("hints when an id-addressed write repeats the previous run's path-based syntax error", () => {
    // The previous run got stuck on this file by path; this run addresses it by id.
    const previous = errorSignature(`${PATHS[ID_A]} 3:5 ')' expected.`);
    const guard = createLoopGuard(previous);
    guard.check([write(ID_A, syntaxNote(`${PATHS[ID_A]} 9:5 ')' expected.`))]);
    expect(guard.takeHint()).toBe(PREVIOUS_ERROR_HINT);
  });

  it("gives no hint without a previous error, and keeps the loop it found", () => {
    const guard = createLoopGuard();
    expect(guard.check([notFound, notFound, notFound])).toMatchObject({ reason: "repeated-error" });
    expect(guard.takeHint()).toBeUndefined();
    expect(guard.check([])).toMatchObject({ reason: "repeated-error" });
    expect(guard.stuck).toMatchObject({ reason: "repeated-error" });
  });
});
