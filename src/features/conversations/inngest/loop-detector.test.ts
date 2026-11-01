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
const write = (fileId: string, note = "") =>
  call("updateFile", `File "App.tsx" updated successfully${note}`, { fileId });
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
    expect(detectLoop([...rounds, write(ID_A)])).toEqual({ reason: "repeated-write", fileId: ID_A });
  });

  it("starts a file's count over after a passing build check", () => {
    const rounds = ["alpha", "beta"].flatMap((what) => [write(ID_A), failedBuild(what)]);
    expect(detectLoop([...rounds, passedBuild(), ...rounds, write(ID_A)])).toBeNull();
  });

  it("starts syntax error counts over after a passing build check", () => {
    const broken = write(ID_A, syntaxNote("App.tsx 1:5 ')' expected."));
    const round = () => [broken, write(ID_A), passedBuild()];
    expect(detectLoop([...round(), ...round(), broken])).toBeNull();
    expect(detectLoop([...round(), broken, broken, broken])).toMatchObject({
      reason: "repeated-syntax-error",
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
      fileId: ID_A,
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

  it("gives no hint without a previous error, and keeps the loop it found", () => {
    const guard = createLoopGuard();
    expect(guard.check([notFound, notFound, notFound])).toMatchObject({ reason: "repeated-error" });
    expect(guard.takeHint()).toBeUndefined();
    expect(guard.check([])).toMatchObject({ reason: "repeated-error" });
    expect(guard.stuck).toMatchObject({ reason: "repeated-error" });
  });
});
