import { describe, expect, it } from "vitest";

import { childrenByParent, sharePath } from "./utils";

describe("share utils", () => {
  it("builds the share page path", () => {
    expect(sharePath("abc")).toBe("/preview/abc");
  });

  it("groups files by parent, folders first, then by name", () => {
    const tree = childrenByParent([
      { _id: "b", parentId: null, name: "b.ts", type: "file" },
      { _id: "src", parentId: null, name: "src", type: "folder" },
      { _id: "a", parentId: null, name: "a.ts", type: "file" },
      { _id: "x", parentId: "src", name: "x.ts", type: "file" },
    ]);
    expect(tree.get(null)?.map((f) => f._id)).toEqual(["src", "a", "b"]);
    expect(tree.get("src")?.map((f) => f._id)).toEqual(["x"]);
    expect(tree.get("a")).toBeUndefined();
  });
});
