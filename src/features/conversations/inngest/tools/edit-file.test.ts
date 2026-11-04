import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import type { Id } from "../../../../../convex/_generated/dataModel";
import { hasUncheckedWrites } from "../build-check-gate";
import { applyEdits, createEditFileTool } from "./edit-file";
import { KNOWN_GOOD_VERSIONS } from "../known-good-versions";

const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;
const internalKey = "key";
const projectId = "project_a" as Id<"projects">;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyEdits", () => {
  it("replaces a unique match and leaves the rest untouched", () => {
    expect(applyEdits("a\nb\nc\n", [{ oldText: "b", newText: "B" }])).toEqual({ content: "a\nB\nc\n" });
  });

  it("fails on a missing match", () => {
    expect(applyEdits("a\n", [{ oldText: "x", newText: "y" }])).toEqual({
      error: "oldText #1 matched 0 times; re-read the file and copy the text exactly.",
    });
  });

  it("fails on an ambiguous match unless replaceAll is set", () => {
    expect(applyEdits("x x x", [{ oldText: "x", newText: "y" }])).toEqual({
      error: "oldText #1 matched 3 times; include more surrounding lines so it matches once, or set replaceAll.",
    });
    expect(applyEdits("x x x", [{ oldText: "x", newText: "y", replaceAll: true }])).toEqual({
      content: "y y y",
    });
  });

  it("counts overlapping matches as ambiguous; replaceAll replaces non-overlapping ones", () => {
    expect(applyEdits("ababa", [{ oldText: "aba", newText: "X" }])).toEqual({
      error: "oldText #1 matched 2 times; include more surrounding lines so it matches once, or set replaceAll.",
    });
    expect(applyEdits("ababa", [{ oldText: "aba", newText: "X", replaceAll: true }])).toEqual({ content: "Xba" });
  });

  it("applies edits in order and fails as a whole when a later one misses", () => {
    expect(
      applyEdits("one two", [
        { oldText: "one", newText: "1" },
        { oldText: "1 two", newText: "done" },
      ]),
    ).toEqual({ content: "done" });
    expect(
      applyEdits("one two", [
        { oldText: "one", newText: "1" },
        { oldText: "one", newText: "2" },
      ]),
    ).toEqual({
      error: "oldText #2 matched 0 times (after the earlier edits); re-read the file and copy the text exactly.",
    });
  });

  it("matches LF text against CRLF content and keeps CRLF", () => {
    expect(applyEdits("a\r\nb\r\nc\r\n", [{ oldText: "a\nb", newText: "a\nB\nb" }])).toEqual({
      content: "a\r\nB\r\nb\r\nc\r\n",
    });
  });

  it("refuses a file that mixes CRLF and LF instead of changing its endings", () => {
    const mixed = { error: "the file mixes CRLF and LF line endings, so editFile can't match it safely; rewrite it with updateFile." };
    expect(applyEdits("a\r\nb\nc\n", [{ oldText: "b", newText: "B" }])).toEqual(mixed);
    expect(applyEdits("\na\r\n", [{ oldText: "a", newText: "A" }])).toEqual(mixed);
  });

  it("fails when the edits leave the content unchanged", () => {
    const unchanged = { error: "the edits leave the file unchanged; make each newText differ from its oldText." };
    expect(applyEdits("a b", [{ oldText: "a", newText: "a" }])).toEqual(unchanged);
    expect(
      applyEdits("a b", [
        { oldText: "a", newText: "c" },
        { oldText: "c", newText: "a" },
      ]),
    ).toEqual(unchanged);
  });

  it("inserts newText literally, without replacement patterns", () => {
    expect(applyEdits("price", [{ oldText: "price", newText: "$&$1" }])).toEqual({ content: "$&$1" });
  });

  it("rejects an empty oldText", () => {
    expect(applyEdits("a", [{ oldText: "", newText: "b" }])).toEqual({
      error: "oldText #1 is empty; copy the exact text to replace from the file.",
    });
  });
});

describe("editFile tool", () => {
  const files = [
    { _id: "dir", name: "src", type: "folder" },
    { _id: "app", name: "App.tsx", type: "file", parentId: "dir" },
  ];
  const edit = (edits: unknown) =>
    createEditFileTool({ projectId, internalKey }).handler({ path: "src/App.tsx", edits } as never, ctx);

  beforeEach(() => {
    mocks.query
      .mockResolvedValue(files)
      .mockResolvedValueOnce(files)
      .mockResolvedValueOnce({ _id: "app", content: "const a = 1;\nconst b = 2;\n" });
  });

  it("writes the edited content in one step", async () => {
    expect(await edit([{ oldText: "b = 2", newText: "b = 3" }])).toBe('File "src/App.tsx" edited successfully');
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey,
      projectId,
      fileId: "app",
      content: "const a = 1;\nconst b = 3;\n",
    });
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when any edit fails", async () => {
    expect(
      await edit([
        { oldText: "a = 1", newText: "a = 9" },
        { oldText: "missing", newText: "x" },
      ]),
    ).toBe(
      'Error: oldText #2 matched 0 times (after the earlier edits); re-read the file and copy the text exactly. "src/App.tsx" was not changed.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["an ambiguous edit", [{ oldText: "const ", newText: "let " }], "matched 2 times"],
    ["an edit that changes nothing", [{ oldText: "a = 1", newText: "a = 1" }], "leave the file unchanged"],
    [
      "edits that cancel out",
      [
        { oldText: "a = 1", newText: "a = 9" },
        { oldText: "a = 9", newText: "a = 1" },
      ],
      "leave the file unchanged",
    ],
  ])("writes nothing for %s, and the build-check gate sees no write", async (_name, edits, message) => {
    const data = await edit(edits);
    expect(data).toContain(message);
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(hasUncheckedWrites([{ toolCalls: [{ tool: { name: "editFile" }, content: { data } }] }])).toBe(false);
  });

  it("reports success for a committed write the syntax check can't run on", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce([{ _id: "types", name: "types.d.ts", type: "file" }])
      .mockResolvedValueOnce({ _id: "types", content: "export type A = 1;\n" })
      .mockResolvedValue([{ _id: "types", name: "types.d.ts", type: "file", content: "export type A = 2;\n" }]);
    const data = await createEditFileTool({ projectId, internalKey }).handler(
      { path: "types.d.ts", edits: [{ oldText: "1", newText: "2" }] } as never,
      ctx,
    );

    expect(data).toBe('File "types.d.ts" edited successfully');
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    expect(hasUncheckedWrites([{ toolCalls: [{ tool: { name: "editFile" }, content: { data } }] }])).toBe(true);
    logged.mockRestore();
  });

  it("checks package.json versions like updateFile (#331)", async () => {
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce([{ _id: "pkg", name: "package.json", type: "file" }])
      .mockResolvedValueOnce({ _id: "pkg", content: '{"dependencies":{"zod":"^3.0.0"}}' });
    const data = await createEditFileTool({ projectId, internalKey }).handler(
      { path: "package.json", edits: [{ oldText: '"zod":"^3.0.0"', newText: '"zod":"^3.0.0","react-router":"latest"' }] } as never,
      ctx,
    );

    expect(data).toContain(`react-router "latest" → "${KNOWN_GOOD_VERSIONS["react-router"]}"`);
    const written = JSON.parse(mocks.mutation.mock.calls[0][1].content);
    expect(written.dependencies["react-router"]).toBe(KNOWN_GOOD_VERSIONS["react-router"]);
  });

  it("reports a syntax error the edit introduced", async () => {
    expect(await edit([{ oldText: "b = 2;", newText: "b = (" }])).toContain("Syntax errors");
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });

  it("rejects a call without edits before touching the project", async () => {
    expect(await edit([])).toBe("Error: Provide at least one edit");
    expect(step.run).not.toHaveBeenCalled();
  });
});
