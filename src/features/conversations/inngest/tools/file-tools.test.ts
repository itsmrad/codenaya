import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { toolResultError } from "../../agent-steps";
import { hasUncheckedWrites } from "../build-check-gate";

type Row = { _id: string; name: string; type: "file" | "folder"; parentId?: string; content?: string };

// A fake `files` table for one project; the tools only ever see this project.
const db = vi.hoisted(() => ({ rows: [] as Row[] }));
const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import type { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { createCreateFilesTool } from "./create-files";
import { createDeleteFilesTool } from "./delete-files";
import { createListFilesTool } from "./list-files";
import { buildProjectTreePromptSection, MAX_PROMPT_TREE_ENTRIES, type ProjectFile } from "./paths";
import { createReadFilesTool } from "./read-files";
import { createRenameFileTool } from "./rename-file";
import { createEditFileTool } from "./edit-file";
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
      : db.rows.map((row) => ({ ...row, content: getFunctionName(ref) === "system:getProjectFilesWithUrls" ? row.content : undefined })),
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

  it("resolves an id directly, so a file past the file-list cap still works", async () => {
    db.rows.push({ _id: "far", name: "far.ts", type: "file", parentId: "src", content: "old" });
    const listed = db.rows.filter((r) => r._id !== "far").map((row) => ({ ...row, content: undefined }));
    mocks.query.mockImplementation(async (ref, args: { fileId?: string }) =>
      getFunctionName(ref) === "system:getFileById"
        ? (db.rows.find((r) => r._id === args.fileId) ?? null)
        : listed,
    );
    expect(await createUpdateFileTool(opts).handler({ fileId: "far", content: "export {};" } as never, ctx)).toBe(
      'File "far.ts" updated successfully',
    );
    expect(await createReadFilesTool(opts).handler({ fileIds: ["far"] } as never, ctx)).toBe(
      JSON.stringify([{ path: "far.ts", content: "export {};" }]),
    );
  });

  // A malformed id, or one from another project (#209), is not in this project's files.
  it.each([
    ["updateFile", () => createUpdateFileTool(opts).handler({ fileId: "foreign", content: "x" } as never, ctx)],
    ["renameFile", () => createRenameFileTool(opts).handler({ fileId: "foreign", newName: "a.ts" } as never, ctx)],
    ["deleteFiles", () => createDeleteFilesTool(opts).handler({ fileIds: ["foreign"] } as never, ctx)],
  ])("%s returns a not-found tool error for an unknown id and writes nothing", async (_name, call) => {
    expect(await call()).toBe(
      'Error: File not found. Address files by path, like "src/App.tsx".',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe("writeFiles tool", () => {
  const rowsNamed = (name: string) => db.rows.filter((r) => r.name === name);

  it.each([
    [["fresh", "fresh/child.ts"]],
    [["fresh/child.ts", "fresh"]],
  ])("refuses a path another path in the call needs as a folder (%j)", async (order) => {
    db.rows = [];
    const result = await write(order.map((path) => ({ path, content: path })));
    expect(result).toBe(
      "Wrote 1 file(s). Created: fresh/child.ts. Failed: fresh (also a folder of another path in this call).",
    );
    expect(rowsNamed("fresh")).toEqual([expect.objectContaining({ type: "folder" })]);
  });

  it("writes a path listed twice once, with the last content", async () => {
    expect(
      await write([
        { path: "src/x.ts", content: "first" },
        { path: "./src/x.ts", content: "last" },
      ]),
    ).toBe("Wrote 1 file(s). Created: src/x.ts.");
    expect(rowsNamed("x.ts")).toEqual([expect.objectContaining({ content: "last" })]);
  });

  it("returns an error after a partial write, which the build-check gate still counts", async () => {
    const commit = mocks.mutation.getMockImplementation()!;
    mocks.mutation.mockImplementationOnce(commit).mockRejectedValueOnce(new Error("fetch failed"));
    const data = await write([
      { path: "src/App.tsx", content: "v2" },
      { path: "package.json", content: '{"name":"x"}' },
    ]);

    expect(data).toBe("Error writing files: fetch failed");
    expect(db.rows.find((r) => r._id === "app")?.content).toBe("v2");
    expect(hasUncheckedWrites([{ toolCalls: [{ tool: { name: "writeFiles" }, content: { data } }] }])).toBe(true);
  });

  it("never writes a folder path ending in / to a file of the same name (#267)", async () => {
    db.rows.push({ _id: "srcfile", name: "src", type: "file", content: "keep" });
    expect(await write([{ path: "src/", content: "x" }])).toBe(
      'Error: No files written. Failed: src/ (ends in "/", so it names a folder; write to a file path).',
    );
    expect(db.rows.find((r) => r._id === "srcfile")?.content).toBe("keep");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

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
      'Wrote 1 file(s). Created: src/ok.ts. Failed: Invalid path "../escape.ts". Use a project-relative path like "src/App.tsx": no leading "/", and no "..", "." or empty segments., src (a folder; write to a file path inside it), package.json/x.ts ("package.json" is a file, not a folder).',
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

describe("post-write checks at every boundary", () => {
  it.each(["update", "edit", "write", "create"])("%s saves, rewrites icons and reports project findings in the same step", async (kind) => {
    db.rows.find((r) => r._id === "pkg")!.content = JSON.stringify({ dependencies: { "lucide-react": "^1.66.0" } });
    const registry = vi.fn(async () => []);
    const content = 'import { Cammera, VercelLogo } from "lucide-react"; import { X } from "./missing"; import absent from "not-installed";';
    const options = { ...opts, registry };
    const result = kind === "update"
      ? await createUpdateFileTool(options).handler({ path: "src/App.tsx", content }, ctx)
      : kind === "edit"
        ? await createEditFileTool(options).handler({ path: "src/App.tsx", edits: [{ oldText: "app", newText: content }] }, ctx)
        : kind === "write"
          ? await createWriteFilesTool(options).handler({ files: [{ path: "src/New.tsx", content }] }, ctx)
          : await createCreateFilesTool(options).handler({ parentId: "src", files: [{ name: "New.tsx", content }] }, ctx);
    expect(toolResultError({ data: result })).toBeUndefined();
    const tool = { name: { update: "updateFile", edit: "editFile", write: "writeFiles", create: "createFiles" }[kind]! };
    expect(hasUncheckedWrites([{ toolCalls: [{ tool, content: { data: result } }] }])).toBe(true);
    expect(result).toContain("[icon-rewrite] Cammera → Camera as Cammera");
    expect(result).toContain("VercelLogo");
    expect(result).toContain("./missing");
    expect(String(result).match(/Project checks/g)).toHaveLength(1);
    expect(db.rows.some((r) => r.content?.includes("Camera as Cammera"))).toBe(true);
    expect(registry).toHaveBeenCalledWith(["not-installed"]);
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it.each(["update", "edit", "write", "create"])("%s remains successful when post-write diagnostics reject", async (kind) => {
    db.rows.find((r) => r._id === "pkg")!.content = JSON.stringify({ dependencies: { "lucide-react": "^1.66.0" } });
    const options = { ...opts, registry: vi.fn(async () => { throw new Error("diagnostics failed"); }) };
    const content = 'import { Cammera } from "lucide-react";';
    const result = kind === "update"
      ? await createUpdateFileTool(options).handler({ path: "src/App.tsx", content }, ctx)
      : kind === "edit"
        ? await createEditFileTool(options).handler({ path: "src/App.tsx", edits: [{ oldText: "app", newText: content }] }, ctx)
        : kind === "write"
          ? await createWriteFilesTool(options).handler({ files: [{ path: "src/New.tsx", content }] }, ctx)
          : await createCreateFilesTool(options).handler({ parentId: "src", files: [{ name: "New.tsx", content }] }, ctx);
    expect(result).toContain("write succeeded");
    expect(result).toContain("[icon-rewrite] Cammera → Camera as Cammera");
    expect(toolResultError({ data: result })).toBeUndefined();
    const name = { update: "updateFile", edit: "editFile", write: "writeFiles", create: "createFiles" }[kind]!;
    expect(hasUncheckedWrites([{ toolCalls: [{ tool: { name }, content: { data: result } }] }])).toBe(true);
    expect(db.rows.some((row) => row.content === content.replace("Cammera", "Camera as Cammera"))).toBe(true);
  });

  it("returns the persisted result on replay without new writes, queries or registry calls", async () => {
    let saved: unknown;
    const replay = { step: { run: async (_id: string, fn: () => unknown) => saved ??= await fn() } } as never;
    const registry = vi.fn(async () => []);
    const tool = createUpdateFileTool({ ...opts, registry });
    const args = { path: "src/App.tsx", content: 'import x from "undeclared";' };
    const first = await tool.handler(args, replay);
    const calls = mocks.query.mock.calls.length;
    expect(await tool.handler(args, replay)).toBe(first);
    expect(mocks.query).toHaveBeenCalledTimes(calls);
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    expect(registry).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful write successful when the diagnostic snapshot fails", async () => {
    mocks.query.mockImplementationOnce(async () => db.rows).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    const result = await createUpdateFileTool(opts).handler({ path: "src/App.tsx", content: "saved" }, ctx);
    expect(result).toContain("write succeeded");
    expect(toolResultError({ data: result })).toBeUndefined();
    expect(hasUncheckedWrites([{ toolCalls: [{ tool: { name: "updateFile" }, content: { data: result } }] }])).toBe(true);
    expect(db.rows.find((r) => r._id === "app")?.content).toBe("saved");
  });

  it("does not check or rewrite a failed create", async () => {
    const result = await createCreateFilesTool(opts).handler({ parentId: "src", files: [{ name: "App.tsx", content: 'import { Cammera } from "lucide-react";' }] }, ctx);
    expect(result).toContain("Created 0");
    expect(result).not.toContain("Project checks");
    expect(db.rows.find((r) => r._id === "app")?.content).toBe("app");
  });
});

// #331: an unpinned package resolves to today's newest major, which the starter may not run.
describe("package.json version pins", () => {
  const latestRouter = JSON.stringify({ dependencies: { "react-router-dom": "latest" } });
  const savedRouterRange = (path = "package.json") =>
    JSON.parse(db.rows.find((r) => r.type === "file" && pathOf(r) === path)!.content!).dependencies[
      "react-router-dom"
    ];

  it("updateFile saves the known-good range and says so", async () => {
    const result = await createUpdateFileTool(opts).handler({ path: "package.json", content: latestRouter }, ctx);
    expect(savedRouterRange()).toMatch(/^\^7\./);
    expect(result).toContain('react-router-dom "latest" →');
  });

  it("createFiles saves the known-good range and says so", async () => {
    db.rows = [];
    const result = await createCreateFilesTool(opts).handler(
      { parentId: "", files: [{ name: "package.json", content: latestRouter }] },
      ctx,
    );
    expect(savedRouterRange()).toMatch(/^\^7\./);
    expect(result).toContain('react-router-dom "latest" →');
  });

  // writeFiles is a package.json write path too, for new and existing files.
  it("writeFiles saves the known-good range and says so", async () => {
    const result = (await createWriteFilesTool(opts).handler(
      {
        files: [
          { path: "package.json", content: latestRouter },
          { path: "apps/web/package.json", content: latestRouter },
          { path: "src/package-notes.json", content: latestRouter },
        ],
      },
      ctx,
    )) as string;
    expect(savedRouterRange()).toMatch(/^\^7\./);
    expect(savedRouterRange("apps/web/package.json")).toMatch(/^\^7\./);
    expect(savedRouterRange("src/package-notes.json")).toBe("latest");
    expect(result.match(/react-router-dom "latest" →/g)).toHaveLength(2);
  });
});
