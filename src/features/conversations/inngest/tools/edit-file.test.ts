import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import type { Id } from "../../../../../convex/_generated/dataModel";
import { applyEdits, createEditFileTool } from "./edit-file";

const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;
const projectId = "project_a" as Id<"projects">;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyEdits", () => {
  const source = "const a = 1;\nconst b = 2;\nconst c = 2;\n";

  it("replaces a unique match", () => {
    expect(applyEdits(source, [{ oldText: "const a = 1;", newText: "const a = 9;" }])).toEqual({
      content: "const a = 9;\nconst b = 2;\nconst c = 2;\n",
    });
  });

  it("refuses a match that is missing", () => {
    expect(applyEdits(source, [{ oldText: "const z", newText: "" }])).toEqual({
      error: expect.stringContaining("oldText #1 matched 0 times"),
    });
  });

  it("refuses an ambiguous match unless replaceAll is set", () => {
    expect(applyEdits(source, [{ oldText: "= 2;", newText: "= 3;" }])).toEqual({
      error: expect.stringContaining("oldText #1 matched 2 times"),
    });
    expect(applyEdits(source, [{ oldText: "= 2;", newText: "= 3;", replaceAll: true }])).toEqual({
      content: "const a = 1;\nconst b = 3;\nconst c = 3;\n",
    });
  });

  it("applies edits in order and fails as a whole when a later one fails", () => {
    expect(
      applyEdits(source, [
        { oldText: "const a = 1;", newText: "const a = 9;" },
        { oldText: "const a = 1;", newText: "x" },
      ]),
    ).toEqual({ error: expect.stringContaining("oldText #2 matched 0 times") });
  });

  it("matches across CRLF and keeps the file's line endings", () => {
    expect(
      applyEdits("one\r\ntwo\r\nthree\r\n", [{ oldText: "one\ntwo", newText: "1\n2" }]),
    ).toEqual({ content: "1\r\n2\r\nthree\r\n" });
  });
});

describe("editFile tool", () => {
  const edit = (edits: Array<{ oldText: string; newText: string }>) =>
    createEditFileTool({ projectId, internalKey: "key" }).handler({ fileId: "f1", edits }, ctx);

  it("writes only the edited span", async () => {
    mocks.query.mockResolvedValue({ _id: "f1", name: "App.tsx", type: "file", content: "a\nb\nc\n" });
    expect(await edit([{ oldText: "b", newText: "B" }])).toBe('File "App.tsx" edited successfully (1 edit)');
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "key",
      projectId,
      fileId: "f1",
      content: "a\nB\nc\n",
    });
  });

  it("writes nothing when an edit fails, and says what to do", async () => {
    mocks.query.mockResolvedValue({ _id: "f1", name: "App.tsx", type: "file", content: "a\n" });
    expect(
      await edit([
        { oldText: "a", newText: "A" },
        { oldText: "missing", newText: "" },
      ]),
    ).toBe('Error: oldText #2 matched 0 times; re-read the file with readFiles and copy the text exactly. Nothing was written to "App.tsx".');
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("returns a tool error for a missing file or a folder", async () => {
    mocks.query.mockResolvedValueOnce(null);
    expect(await edit([{ oldText: "a", newText: "b" }])).toContain("not found");
    mocks.query.mockResolvedValueOnce({ _id: "f1", name: "src", type: "folder" });
    expect(await edit([{ oldText: "a", newText: "b" }])).toContain("is a folder");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("rejects an empty edit list", async () => {
    expect(await edit([])).toBe("Error: At least one edit is required");
  });
});
