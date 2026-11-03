import { describe, expect, it } from "vitest";

import { isStarterOnly } from "./starter-only";
import { VITE_REACT_STARTER } from "./vite-starter";

/** Project rows for the given file paths, folders implied, ids like `id:src/App.tsx`. */
const rowsFor = (paths: string[]) => {
  const rows = new Map<string, { _id: string; name: string; type: "file" | "folder"; parentId?: string }>();
  for (const path of paths) {
    const parts = path.split("/");
    parts.forEach((name, depth) => {
      const at = parts.slice(0, depth + 1).join("/");
      const parent = parts.slice(0, depth).join("/");
      if (rows.has(at)) return;
      rows.set(at, {
        _id: `id:${at}`,
        name,
        type: depth === parts.length - 1 ? "file" : "folder",
        ...(parent ? { parentId: `id:${parent}` } : {}),
      });
    });
  }
  return [...rows.values()];
};

const STARTER_PATHS = VITE_REACT_STARTER.map((file) => file.path);

describe("isStarterOnly", () => {
  it("is true for a project that holds exactly the seeded starter", () => {
    expect(isStarterOnly(rowsFor(STARTER_PATHS))).toBe(true);
  });

  it.each([
    ["an empty project", []],
    ["a project the agent has added to", [...STARTER_PATHS, "src/pages/Home.tsx"]],
    ["a partly seeded project", STARTER_PATHS.slice(1)],
  ])("is false for %s", (_, paths) => {
    expect(isStarterOnly(rowsFor(paths))).toBe(false);
  });
});
