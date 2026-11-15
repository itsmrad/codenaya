import { describe, expect, it } from "vitest";

import type { AgentStep } from "@/features/conversations/agent-steps";

import { recentlyChangedFiles } from "./recently-changed";

const files = [
  { _id: "d1", name: "src", type: "folder" as const },
  { _id: "f1", name: "a.ts", type: "file" as const, parentId: "d1" },
  { _id: "f2", name: "b.ts", type: "file" as const, parentId: "d1" },
  { _id: "f3", name: "README.md", type: "file" as const },
];

const write = (id: string, tool: string, targets: string[], status: AgentStep["status"] = "done"): AgentStep => ({
  id,
  kind: "tool",
  tool,
  targets,
  status,
  startedAt: 0,
});

const paths = (steps: AgentStep[], limit?: number) =>
  recentlyChangedFiles(steps, files, limit).map((entry) => entry.path);

describe("recentlyChangedFiles (#315)", () => {
  it("lists the last run's written files, newest first and without duplicates", () => {
    const steps = [
      write("1", "writeFiles", ["src/a.ts", "README.md"]),
      write("2", "editFile", ["src/b.ts"]),
      write("3", "editFile", ["src/a.ts"]),
    ];
    // a was written again last, so it leads; within the first step the call's order holds.
    expect(paths(steps)).toEqual(["src/a.ts", "src/b.ts", "README.md"]);
  });

  it("ranks a path written twice by its last write", () => {
    const steps = [
      write("1", "editFile", ["src/a.ts"]),
      write("2", "editFile", ["src/b.ts"]),
      write("3", "editFile", ["src/a.ts"]),
    ];
    expect(paths(steps)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(paths([...steps, write("4", "editFile", ["src/b.ts"])])).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("drops paths that no longer exist, folders, reads and unfinished writes", () => {
    const steps = [
      write("1", "writeFiles", ["src/gone.ts", "src"]),
      write("2", "readFiles", ["src/a.ts"]),
      write("3", "editFile", ["README.md"], "running"),
      write("4", "editFile", ["src/b.ts"]),
    ];
    expect(paths(steps)).toEqual(["src/b.ts"]);
  });

  it("caps the list and is empty with no steps", () => {
    const steps = [write("1", "writeFiles", ["src/a.ts", "src/b.ts", "README.md"])];
    expect(paths(steps, 2)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(paths([])).toEqual([]);
  });
});
