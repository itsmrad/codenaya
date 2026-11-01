import { describe, expect, it } from "vitest";

import {
  PREVIOUS_ERROR_HINT,
  createLoopGuard,
  detectLoop,
  errorSignature,
} from "./loop-detector";
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

  it("trips when one file is written four times, not three", () => {
    expect(detectLoop(times(3, () => write(ID_A)))).toBeNull();
    expect(detectLoop(times(4, () => write(ID_A)))).toEqual({ reason: "repeated-write", fileId: ID_A });
  });

  it("counts writes per file, and not failed writes", () => {
    expect(detectLoop(times(6, (i) => write(i % 2 ? ID_A : ID_B)))).toBeNull();
    const failed = call("updateFile", "Error update file: conflict", { fileId: ID_A });
    expect(detectLoop([...times(3, () => write(ID_A)), failed])).toBeNull();
  });

  it("counts a turn's parallel calls one by one", () => {
    const calls = times(4, () => write(ID_A));
    const turn = {
      output: calls.flatMap((c) => c.output),
      toolCalls: calls.flatMap((c) => c.toolCalls),
    };
    expect(detectLoop([turn])).toMatchObject({ reason: "repeated-write" });
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

  it("keeps syntax errors in different files apart", () => {
    const results = times(4, (i) =>
      call("createFiles", `Created 1 file${syntaxNote(`${i}.tsx 1:1 ')' expected.`)}`),
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
