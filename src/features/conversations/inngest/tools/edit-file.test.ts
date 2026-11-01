import { getFunctionName } from "convex/server";
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
  /**
   * A project with `src/` holding one file. `getProjectFiles` (the path index,
   * #292) lists it without text; `getFileById` returns it with `content`.
   */
  const project = (file: { name: string; content?: string }) => {
    const rows = [
      { _id: "d1", name: "src", type: "folder" },
      { _id: "f1", name: file.name, type: "file", parentId: "d1" },
    ];
    mocks.query.mockImplementation(async (ref, args: { fileId?: string }) =>
      getFunctionName(ref) === "system:getProjectFiles"
        ? rows
        : args.fileId === "f1"
          ? { ...rows[1], content: file.content }
          : (rows.find((row) => row._id === args.fileId) ?? null),
    );
  };
  const edit = (path: string, edits: Array<{ oldText: string; newText: string }>) =>
    createEditFileTool({ projectId, internalKey: "key" }).handler({ path, edits }, ctx);

  it("writes only the edited span, found by path", async () => {
    project({ name: "App.tsx", content: "a\nb\nc\n" });
    expect(await edit("src/App.tsx", [{ oldText: "b", newText: "B" }])).toBe(
      'File "src/App.tsx" edited successfully (1 edit)',
    );
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "key",
      projectId,
      fileId: "f1",
      content: "a\nB\nc\n",
    });
  });

  it("pins an edited package.json to the known-good versions (#331)", async () => {
    project({ name: "package.json", content: '{ "dependencies": { "react": "^19.0.0" } }' });
    const result = await edit("src/package.json", [{ oldText: '"^19.0.0"', newText: '"latest"' }]);

    expect(result).toContain("Pinned to the starter's known-good versions in package.json: react");
    const written = (mocks.mutation.mock.calls[0][1] as { content: string }).content;
    expect(JSON.parse(written).dependencies.react).not.toBe("latest");
  });

  it("writes nothing when an edit fails, and says what to do", async () => {
    project({ name: "App.tsx", content: "a\n" });
    expect(
      await edit("src/App.tsx", [
        { oldText: "a", newText: "A" },
        { oldText: "missing", newText: "" },
      ]),
    ).toBe(
      'Error: oldText #2 matched 0 times; re-read the file with readFiles and copy the text exactly. Nothing was written to "src/App.tsx".',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("returns a tool error for a missing path, a folder or a binary file", async () => {
    project({ name: "logo.png" });
    expect(await edit("src/nope.ts", [{ oldText: "a", newText: "b" }])).toContain('"src/nope.ts" not found');
    expect(await edit("src", [{ oldText: "a", newText: "b" }])).toContain('"src" is a folder');
    expect(await edit("src/logo.png", [{ oldText: "a", newText: "b" }])).toContain("no text content");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("still reads a pre-#292 call that names the file by id", async () => {
    project({ name: "App.tsx", content: "x" });
    const result = await createEditFileTool({ projectId, internalKey: "key" }).handler(
      { fileId: "f1", edits: [{ oldText: "x", newText: "y" }] } as never,
      ctx,
    );
    expect(result).toBe('File "src/App.tsx" edited successfully (1 edit)');
  });

  it("rejects an empty edit list", async () => {
    expect(await edit("src/App.tsx", [])).toBe("Error: At least one edit is required");
  });
});
