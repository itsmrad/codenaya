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
import { ancestorsOf, parseAgentPath } from "./paths";
import { createWriteFilesTool } from "./write-files";
import { createListFilesTool } from "./list-files";
import { createUpdateFileTool } from "./update-file";
import { createDeleteFilesTool } from "./delete-files";

const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;
const internalKey = "key";
const projectId = "project_a" as Id<"projects">;

/** An existing project: src/ holding App.tsx, and package.json at the root. */
const TREE = [
  { _id: "d_src", name: "src", type: "folder" },
  { _id: "f_app", name: "App.tsx", type: "file", parentId: "d_src" },
  { _id: "f_pkg", name: "package.json", type: "file" },
];

const mutationsNamed = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === `system:${name}`).map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  let nextId = 0;
  mocks.query.mockImplementation(async (ref, args: { fileId?: string }) => {
    if (getFunctionName(ref) === "system:getProjectFiles") return TREE;
    return TREE.find((file) => file._id === args.fileId) ?? null;
  });
  mocks.mutation.mockImplementation(async (ref, args: { files?: Array<{ name: string }> }) => {
    switch (getFunctionName(ref)) {
      case "system:createFolder":
        return `d_new${nextId++}`;
      case "system:createFiles":
        return (args.files ?? []).map(({ name }) => ({ name, fileId: `f_new${nextId++}` }));
      default:
        return null;
    }
  });
});

describe("parseAgentPath", () => {
  it("accepts project-relative paths and drops a leading ./", () => {
    expect(parseAgentPath("src/App.tsx")).toEqual({ path: "src/App.tsx" });
    expect(parseAgentPath("./src/App.tsx")).toEqual({ path: "src/App.tsx" });
  });

  it.each(["", "/etc/passwd", "C:/x.ts", "src\\App.tsx", "../secrets.ts", "src/../x.ts", "src//App.tsx", "src/./App.tsx"])(
    "refuses %j with an actionable error",
    (raw) => {
      expect(parseAgentPath(raw)).toEqual({ error: expect.any(String) });
    },
  );

  it("lists every folder above a path, outermost first", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.ts")).toEqual([]);
  });
});

describe("writeFiles", () => {
  const write = (files: Array<{ path: string; content: string }>) =>
    createWriteFilesTool({ projectId, internalKey }).handler({ files }, ctx);

  it("creates nested folders once and the files inside them, in one call", async () => {
    const result = await write([
      { path: "src/components/ui/button.tsx", content: "b" },
      { path: "src/components/ui/card.tsx", content: "c" },
    ]);

    expect(result).toBe("Created src/components/ui/button.tsx\nCreated src/components/ui/card.tsx");
    // src exists; components and ui are created once, ui inside components.
    expect(mutationsNamed("createFolder")).toEqual([
      expect.objectContaining({ name: "components", parentId: "d_src" }),
      expect.objectContaining({ name: "ui", parentId: "d_new0" }),
    ]);
    expect(mutationsNamed("createFiles").map((args) => (args as { parentId: string }).parentId)).toEqual([
      "d_new1",
      "d_new1",
    ]);
  });

  it("overwrites an existing file and writes root-level files last (#254)", async () => {
    const result = await write([
      { path: "package.json", content: "{}" },
      { path: "src/App.tsx", content: "app" },
    ]);

    expect(result).toBe("Updated src/App.tsx\nUpdated package.json");
    expect(mutationsNamed("updateFile")).toEqual([
      expect.objectContaining({ fileId: "f_app", content: "app" }),
      expect.objectContaining({ fileId: "f_pkg", content: "{}" }),
    ]);
  });

  it("pins package.json to the known-good versions, like createFiles (#331)", async () => {
    const result = await write([{ path: "package.json", content: JSON.stringify({ dependencies: { react: "latest" } }) }]);

    expect(result).toContain("Pinned to the starter's known-good versions in package.json: react");
    const [written] = mutationsNamed("updateFile") as Array<{ content: string }>;
    expect(JSON.parse(written.content).dependencies.react).not.toBe("latest");
  });

  it("refuses a folder path, a path inside a file and a .. path, and writes the rest", async () => {
    const result = await write([
      { path: "src", content: "x" },
      { path: "src/App.tsx/inner.ts", content: "x" },
      { path: "../outside.ts", content: "x" },
      { path: "src/ok.ts", content: "ok" },
    ]);

    expect(result).toContain('Error: "src" is a folder');
    expect(result).toContain('Error: "src/App.tsx" is a file, so "src/App.tsx/inner.ts" cannot be inside it');
    expect(result).toContain('Error: "../outside.ts" has an empty, "." or ".." segment');
    expect(result).toContain("Created src/ok.ts");
    expect(mutationsNamed("createFolder")).toEqual([]);
    expect(mutationsNamed("createFiles")).toHaveLength(1);
  });
});

describe("tools addressed by path", () => {
  it("listFiles returns sorted paths, folders ending in /, with IDs only when asked", async () => {
    const list = createListFilesTool({ projectId, internalKey });
    expect(await list.handler({}, ctx)).toBe("package.json\nsrc/\nsrc/App.tsx");
    expect(await list.handler({ withIds: true }, ctx)).toBe(
      "package.json (f_pkg)\nsrc/ (d_src)\nsrc/App.tsx (f_app)",
    );
  });

  it("updateFile writes the file at a path, and names the path when there is none", async () => {
    const update = createUpdateFileTool({ projectId, internalKey });
    expect(await update.handler({ path: "src/App.tsx", content: "export {};" }, ctx)).toBe(
      'File "App.tsx" updated successfully',
    );
    expect(mutationsNamed("updateFile")).toEqual([expect.objectContaining({ fileId: "f_app", content: "export {};" })]);

    expect(await update.handler({ path: "src/Missing.tsx", content: "x" }, ctx)).toBe(
      "Error: Nothing at \"src/Missing.tsx\". Use listFiles to see the project's paths. To create a new file, use writeFiles.",
    );
  });

  it("deleteFiles deletes by path and deletes nothing when one path is missing", async () => {
    const remove = createDeleteFilesTool({ projectId, internalKey });
    expect(await remove.handler({ paths: ["src/App.tsx", "nope.ts"] }, ctx)).toBe(
      "Error: Nothing at \"nope.ts\". Use listFiles to see the project's paths.",
    );
    expect(mutationsNamed("deleteFile")).toEqual([]);

    expect(await remove.handler({ paths: ["src/App.tsx"] }, ctx)).toBe('Deleted file "App.tsx" successfully');
    expect(mutationsNamed("deleteFile")).toEqual([expect.objectContaining({ fileId: "f_app" })]);
  });
});
