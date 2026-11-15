import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { buildFilePaths, planFolderCreation, splitPath } from "./github-tree";

const file = (id: string, name: string, parentId?: string) =>
  ({
    _id: id as Id<"files">,
    name,
    parentId: parentId as Id<"files"> | undefined,
  }) as Doc<"files">;

describe("buildFilePaths", () => {
  it("keys each file by its full path, stopping at a missing parent", () => {
    const src = file("1", "src");
    const page = file("2", "page.tsx", "1");
    const orphan = file("3", "orphan.ts", "missing");

    expect(buildFilePaths([page, src, orphan])).toEqual({
      src,
      "src/page.tsx": page,
      "orphan.ts": orphan,
    });
  });
});

describe("splitPath", () => {
  it("splits a nested path and a root name", () => {
    expect(splitPath("a/b/c.ts")).toEqual({ name: "c.ts", parentPath: "a/b" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", parentPath: "" });
  });

  it("creates a missing parent folder and preserves the imported file's path", () => {
    const folderIdMap: Record<string, Id<"files">> = {};
    const folders = planFolderCreation(["src"], ["src/missing/page.tsx"]).map(
      ({ path, name, parentPath }) => {
        const folder = file(path, name, folderIdMap[parentPath]);
        folderIdMap[path] = folder._id;
        return folder;
      },
    );
    const { name, parentPath } = splitPath("src/missing/page.tsx");
    const parentId = parentPath ? folderIdMap[parentPath] : undefined;
    const imported = file("page-id", name, parentId);

    expect(parentPath).toBe("src/missing");
    expect(parentId).toBe(folderIdMap["src/missing"]);
    expect(buildFilePaths([...folders, imported])).toEqual({
      src: folders[0],
      "src/missing": folders[1],
      "src/missing/page.tsx": imported,
    });
  });
});

describe("planFolderCreation", () => {
  it("keeps duplicate folder names under separate parents", () => {
    expect(planFolderCreation(["a/ui", "b/ui", "a", "b"])).toEqual([
      { path: "a", name: "a", parentPath: "" },
      { path: "b", name: "b", parentPath: "" },
      { path: "a/ui", name: "ui", parentPath: "a" },
      { path: "b/ui", name: "ui", parentPath: "b" },
    ]);
  });

  it("orders parents before children listed ahead of them", () => {
    expect(planFolderCreation(["src/components", "src", "src/components/ui"])).toEqual([
      { path: "src", name: "src", parentPath: "" },
      { path: "src/components", name: "components", parentPath: "src" },
      { path: "src/components/ui", name: "ui", parentPath: "src/components" },
    ]);
  });
});
