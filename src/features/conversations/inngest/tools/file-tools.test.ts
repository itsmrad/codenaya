import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

type Row = { _id: string; name: string; type: "file" | "folder"; parentId?: string; content?: string };

// A fake `files` table for one project; the tools only ever see this project.
const db = vi.hoisted(() => ({ rows: [] as Row[] }));
const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import type { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { createDeleteFilesTool } from "./delete-files";
import { createListFilesTool } from "./list-files";
import { buildProjectTreePromptSection, MAX_PROMPT_TREE_ENTRIES, type ProjectFile } from "./paths";
import { createReadFilesTool } from "./read-files";
import { createRenameFileTool } from "./rename-file";
import { createUpdateFileTool } from "./update-file";
import { createWriteFilesTool } from "./write-files";

// Runs the step body inline, so a throw inside step.run propagates like it
// would to Inngest (which retries the step).
const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;
const internalKey = "key";
const projectId = "project_a" as Id<"projects">;
const opts = { projectId, internalKey };

const insert = (row: Omit<Row, "_id">) => {
  const _id = `id${db.rows.length}`;
  db.rows.push({ ...row, _id });
  return _id;
};

const pathOf = (row: Row): string => {
  const parent = db.rows.find((r) => r._id === row.parentId);
  return parent ? `${pathOf(parent)}/${row.name}` : row.name;
};
const filePaths = () => db.rows.filter((r) => r.type === "file").map(pathOf).sort();
const mutationNames = () => mocks.mutation.mock.calls.map(([ref]) => getFunctionName(ref));

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [
    { _id: "src", name: "src", type: "folder" },
    { _id: "app", name: "App.tsx", type: "file", parentId: "src", content: "app" },
    { _id: "pkg", name: "package.json", type: "file", content: "{}" },
  ];
  mocks.query.mockImplementation(async (ref, args: { fileId?: string }) =>
    getFunctionName(ref) === "system:getFileById"
      ? (db.rows.find((r) => r._id === args.fileId) ?? null)
      : db.rows.map((row) => ({ ...row, content: undefined })),
  );
  mocks.mutation.mockImplementation(async (ref, args: Record<string, never>) => {
    switch (getFunctionName(ref)) {
      case "system:createFolder":
        return insert({ name: args.name, type: "folder", parentId: args.parentId });
      case "system:createFiles":
        return (args.files as { name: string; content: string }[]).map((file) => {
          const existing = db.rows.find(
            (r) => r.type === "file" && r.name === file.name && r.parentId === args.parentId,
          );
          return existing
            ? { name: file.name, fileId: existing._id, error: "File already exists" }
            : { name: file.name, fileId: insert({ ...file, type: "file", parentId: args.parentId }) };
        });
      case "system:updateFile":
        db.rows.find((r) => r._id === args.fileId)!.content = args.content;
        return args.fileId;
      case "system:renameFile":
        db.rows.find((r) => r._id === args.fileId)!.name = args.newName;
        return;
      case "system:deleteFile":
        db.rows = db.rows.filter((r) => r._id !== args.fileId);
        return;
    }
  });
});

describe("getFileByAgentId", () => {
  it("rethrows other errors so Inngest can retry them", async () => {
    mocks.query.mockRejectedValue(new Error("fetch failed"));
    await expect(getFileByAgentId(internalKey, projectId, "f1")).rejects.toThrow("fetch failed");
  });
});

describe("path resolution", () => {
  it("reads files by path and reports the ones it can't find by path", async () => {
    const result = (await createReadFilesTool(opts).handler(
      { paths: ["src/App.tsx", "./package.json", "src/Missing.tsx"] },
      ctx,
    )) as string;
    const [json, ...errors] = result.split("\n");
    expect(JSON.parse(json)).toEqual([
      { path: "src/App.tsx", content: "app" },
      { path: "package.json", content: "{}" },
    ]);
    expect(errors).toEqual([
      'Error: "src/Missing.tsx" not found. Use a path from the project\'s file list.',
    ]);
  });

  it.each(["/etc/passwd", "../secrets", "src/../package.json", "src//App.tsx", ""])(
    "rejects %j with an actionable error and touches nothing",
    async (path) => {
      const result = await createUpdateFileTool(opts).handler({ path, content: "x" }, ctx);
      expect(result).toBe(
        `Error: Invalid path "${path}". Use a project-relative path like "src/App.tsx": no leading "/", and no "..", "." or empty segments.`,
      );
      expect(mocks.mutation).not.toHaveBeenCalled();
    },
  );

  it("updates, renames and deletes by path", async () => {
    expect(await createUpdateFileTool(opts).handler({ path: "src/App.tsx", content: "v2" }, ctx)).toBe(
      'File "src/App.tsx" updated successfully',
    );
    expect(await createRenameFileTool(opts).handler({ path: "src/App.tsx", newName: "Main.tsx" }, ctx)).toBe(
      'Renamed "src/App.tsx" to "Main.tsx" successfully',
    );
    expect(await createDeleteFilesTool(opts).handler({ paths: ["src/"] }, ctx)).toBe(
      'Deleted folder "src" successfully',
    );
    expect(db.rows.find((r) => r.name === "Main.tsx")?.content).toBe("v2");
  });

  it("deletes nothing when any path is wrong", async () => {
    expect(await createDeleteFilesTool(opts).handler({ paths: ["package.json", "nope.ts"] }, ctx)).toBe(
      'Error: "nope.ts" not found. Use a path from the project\'s file list.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("names the folder's path, not its id, when asked to update a folder (#219)", async () => {
    expect(await createUpdateFileTool(opts).handler({ path: "src", content: "x" }, ctx)).toBe(
      'Error: "src" is a folder, not a file. You can only update file contents.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("passes the run's projectId to the write", async () => {
    await createUpdateFileTool(opts).handler({ path: "package.json", content: "x" }, ctx);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey,
      projectId,
      fileId: "pkg",
      content: "x",
    });
  });
});

// Saved runs replay tool calls made before #292 with document ids.
describe("legacy id calls", () => {
  it("still reads, updates and renames by id, answering with paths", async () => {
    expect(await createReadFilesTool(opts).handler({ fileIds: ["app"] } as never, ctx)).toBe(
      JSON.stringify([{ path: "src/App.tsx", content: "app" }]),
    );
    expect(await createUpdateFileTool(opts).handler({ fileId: "app", content: "v2" } as never, ctx)).toBe(
      'File "src/App.tsx" updated successfully',
    );
    expect(await createRenameFileTool(opts).handler({ fileId: "app", newName: "A.tsx" } as never, ctx)).toBe(
      'Renamed "src/App.tsx" to "A.tsx" successfully',
    );
  });

  // A malformed id, or one from another project (#209), is not in this project's files.
  it.each([
    ["updateFile", () => createUpdateFileTool(opts).handler({ fileId: "foreign", content: "x" } as never, ctx)],
    ["renameFile", () => createRenameFileTool(opts).handler({ fileId: "foreign", newName: "a.ts" } as never, ctx)],
    ["deleteFiles", () => createDeleteFilesTool(opts).handler({ fileIds: ["foreign"] } as never, ctx)],
  ])("%s returns a not-found tool error for an unknown id and writes nothing", async (_name, call) => {
    expect(await call()).toBe(
      'Error: File with ID "foreign" not found. Address files by path, like "src/App.tsx".',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe("writeFiles tool", () => {
  const write = (files: { path: string; content: string }[]) =>
    createWriteFilesTool(opts).handler({ files }, ctx) as Promise<string>;

  it("creates nested folders and files in one call, with no createFolder calls from the agent", async () => {
    const result = await write([
      { path: "src/components/ui/button.tsx", content: "b" },
      { path: "src/components/ui/card.tsx", content: "c" },
      { path: "src/App.tsx", content: "v2" },
      { path: "README.md", content: "r" },
    ]);

    expect(result).toBe(
      "Wrote 4 file(s). Created: src/components/ui/button.tsx, src/components/ui/card.tsx, README.md. Updated: src/App.tsx.",
    );
    expect(filePaths()).toEqual([
      "README.md",
      "package.json",
      "src/App.tsx",
      "src/components/ui/button.tsx",
      "src/components/ui/card.tsx",
    ]);
    expect(db.rows.filter((r) => r.name === "src")).toHaveLength(1);
    expect(db.rows.find((r) => r._id === "app")?.content).toBe("v2");
    // Root files land last (#254).
    expect(mutationNames().at(-1)).toBe("system:createFiles");
    expect(mocks.mutation.mock.calls.at(-1)?.[1]).toMatchObject({ parentId: undefined });
  });

  it("refuses to write over a folder or under a file, and still writes the rest", async () => {
    const result = await write([
      { path: "src", content: "x" },
      { path: "package.json/x.ts", content: "x" },
      { path: "../escape.ts", content: "x" },
      { path: "src/ok.ts", content: "ok" },
    ]);
    expect(result).toBe(
      'Wrote 1 file(s). Created: src/ok.ts. Failed: src (a folder; write to a file path inside it), package.json/x.ts ("package.json" is a file, not a folder), Invalid path "../escape.ts". Use a project-relative path like "src/App.tsx": no leading "/", and no "..", "." or empty segments..',
    );
    expect(db.rows.filter((r) => r.type === "folder")).toHaveLength(1);
  });

  it("is a tool error when nothing was written", async () => {
    expect(await write([{ path: "src", content: "x" }])).toBe(
      "Error: No files written. Failed: src (a folder; write to a file path inside it).",
    );
  });

  it("reports syntax errors by path", async () => {
    expect(await write([{ path: "src/bad.ts", content: "const = 1" }])).toMatch(
      /Syntax errors .*: src\/bad\.ts \d+:\d+/,
    );
  });
});

describe("listFiles tool", () => {
  it("returns sorted paths, folders ending in /, and ids only on request", async () => {
    const list = createListFilesTool(opts);
    expect(await list.handler({ withIds: false }, ctx)).toBe("package.json\nsrc/\nsrc/App.tsx");
    expect(JSON.parse((await list.handler({ withIds: true }, ctx)) as string)).toEqual([
      { path: "package.json", id: "pkg" },
      { path: "src/", id: "src" },
      { path: "src/App.tsx", id: "app" },
    ]);
  });
});

describe("project tree prompt section", () => {
  const file = (path: string, type: "file" | "folder" = "file"): ProjectFile => {
    const slash = path.lastIndexOf("/");
    return {
      _id: path,
      name: path.slice(slash + 1),
      type,
      ...(slash > 0 ? { parentId: path.slice(0, slash) } : {}),
    } as unknown as ProjectFile;
  };

  it("lists every path in a fixed order, whatever order the files come in", () => {
    const files = [file("src", "folder"), file("src/main.tsx"), file("index.html"), file("src/App.tsx")];
    const section = buildProjectTreePromptSection(files);
    expect(section).toBe(
      [
        "\n\n## Project files",
        'Every file and folder at the start of this run (folders end in "/"). Address files by these paths.',
        "index.html",
        "src/",
        "src/App.tsx",
        "src/main.tsx",
      ].join("\n"),
    );
    expect(buildProjectTreePromptSection([...files].reverse())).toBe(section);
  });

  it("says so when the project is empty", () => {
    expect(buildProjectTreePromptSection([])).toBe("\n\n## Project files\nThe project is empty.");
  });

  it("caps the list, keeping shallow paths, and counts the rest", () => {
    const deep = Array.from({ length: MAX_PROMPT_TREE_ENTRIES + 50 }, (_, i) =>
      file(`src/f${String(i).padStart(4, "0")}.ts`),
    );
    const section = buildProjectTreePromptSection([file("src", "folder"), file("package.json"), ...deep]);
    const lines = section.split("\n").slice(4);
    expect(lines).toHaveLength(MAX_PROMPT_TREE_ENTRIES + 1);
    expect(lines.slice(0, 2)).toEqual(["package.json", "src/"]);
    expect(lines.at(-1)).toBe("+52 more (call listFiles to see them)");
  });
});

describe("line-ranged reads (#296)", () => {
  it("preserves full reads and legacy calls byte-for-byte", async () => {
    db.rows[1].content = "a\r\nb\n";
    for (const params of [{ paths: ["src/App.tsx"] }, { fileIds: ["app"] }]) {
      expect(await createReadFilesTool(opts).handler(params as never, ctx)).toBe(JSON.stringify([
        { path: "src/App.tsx", content: "a\r\nb\n" },
      ]));
    }
  });

  it("numbers only the requested inclusive range with its path and actual bounds", async () => {
    db.rows[1].content = "first\r\nsecond\r\nthird";
    expect(await createReadFilesTool(opts).handler({ paths: ["src/App.tsx"], ranges: [
      { path: "./src/App.tsx", startLine: 2, endLine: 2 },
    ] }, ctx)).toBe("File: src/App.tsx (lines 2-2 of 3)\n2: second");
  });

  it("combines unchanged full reads with a ranged file", async () => {
    expect(await createReadFilesTool(opts).handler({
      paths: ["src/App.tsx", "package.json"],
      ranges: [{ path: "src/App.tsx", startLine: 1 }],
    }, ctx)).toBe('[{"path":"package.json","content":"{}"}]\nFile: src/App.tsx (lines 1-1 of 1)\n1: app');
  });

  it("clamps out-of-range requests and handles empty files", async () => {
    for (const content of ["first\nlast", ""]) {
      db.rows[1].content = content;
      const result = await createReadFilesTool(opts).handler({ paths: ["src/App.tsx"], ranges: [
        { path: "src/App.tsx", startLine: 20, endLine: 30 },
      ] }, ctx);
      expect(result).toContain("requested range clamped");
      expect(result).toContain(content ? "2: last" : "1: ");
    }
  });

  it.each([{ startLine: 0 }, { startLine: 2.5 }, { startLine: 3, endLine: 2 }])("rejects invalid range %j", async (range) => {
    const result = await createReadFilesTool(opts).handler({ paths: ["src/App.tsx"], ranges: [
      { path: "src/App.tsx", ...range },
    ] }, ctx);
    expect(result).toMatch(/^Error:/);
    expect(step.run).not.toHaveBeenCalled();
  });
});
