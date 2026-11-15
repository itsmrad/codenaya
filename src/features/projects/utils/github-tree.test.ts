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
});

describe("planFolderCreation", () => {
  it("orders parents before children listed ahead of them", () => {
    expect(planFolderCreation(["src/components", "src", "src/components/ui"])).toEqual([
      { path: "src", name: "src", parentPath: "" },
      { path: "src/components", name: "components", parentPath: "src" },
      { path: "src/components/ui", name: "ui", parentPath: "src/components" },
    ]);
  });
});
