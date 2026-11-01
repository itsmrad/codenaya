import { describe, expect, it } from "vitest";

import { buildStarterPromptSection } from "./starter-prompt";
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

describe("buildStarterPromptSection", () => {
  it("lists every starter file and folder with its id and says to skip listFiles and scaffoldViteApp", () => {
    const section = buildStarterPromptSection(rowsFor(STARTER_PATHS));

    expect(section).toContain("Do not call listFiles or scaffoldViteApp");
    expect(section).toContain("- package.json (file, id: id:package.json)");
    expect(section).toContain("- src/lib (folder, id: id:src/lib)");
    expect(section).toContain("- src/App.tsx (file, id: id:src/App.tsx)");
  });

  it.each([
    ["an empty project", []],
    ["a project the agent has added to", [...STARTER_PATHS, "src/pages/Home.tsx"]],
    ["a project missing a starter file", STARTER_PATHS.slice(1)],
  ])("is empty for %s", (_, paths) => {
    expect(buildStarterPromptSection(rowsFor(paths))).toBe("");
  });
});
