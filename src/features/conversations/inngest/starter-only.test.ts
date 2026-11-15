import { describe, expect, it } from "vitest";

import { isStarterOnly, promptFramework, starterFramework } from "./starter-only";
import { NEXT_APP_STARTER } from "./next-starter";
import { TANSTACK_START_STARTER } from "./tanstack-start-starter";
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
    expect(starterFramework(rowsFor(STARTER_PATHS))).toBe("vite");
  });

  it("recognises the Next starter and rejects partial or mixed starters", () => {
    const paths = NEXT_APP_STARTER.map(({ path }) => path);
    expect(isStarterOnly(rowsFor(paths))).toBe(true);
    expect(starterFramework(rowsFor(paths))).toBe("next");
    expect(isStarterOnly(rowsFor(paths.slice(1)))).toBe(false);
    expect(isStarterOnly(rowsFor([...paths, "vite.config.ts"]))).toBe(false);
  });

  it("recognises the TanStack Start starter", () => {
    const paths = TANSTACK_START_STARTER.map(({ path }) => path);
    expect(starterFramework(rowsFor(paths))).toBe("tanstack-start");
    expect(isStarterOnly(rowsFor([...paths, "src/routes/about.tsx"]))).toBe(false);
  });

  it.each([
    ["an empty project", []],
    ["a project the agent has added to", [...STARTER_PATHS, "src/pages/Home.tsx"]],
    ["a partly seeded project", STARTER_PATHS.slice(1)],
  ])("is false for %s", (_, paths) => {
    expect(isStarterOnly(rowsFor(paths))).toBe(false);
  });
});

describe("promptFramework", () => {
  it.each([
    ["Build a dashboard", "vite"],
    ["Use Next.js for a dashboard", "next"],
    ["Use TanStack Start for a dashboard", "tanstack-start"],
    ["TanStack Start, not Next.js", "tanstack-start"],
    ["Use Vite with TanStack Query", "vite"],
    ["Next.js with TanStack Query", "next"],
  ])("picks the starter for %s", (prompt, framework) => {
    expect(promptFramework(prompt)).toBe(framework);
  });
});
