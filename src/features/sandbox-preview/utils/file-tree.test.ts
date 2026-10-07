import { describe, expect, it } from "vitest";

import { getChangedFiles } from "./file-tree";

describe("getChangedFiles", () => {
  const synced = new Map([
    ["vite.config.ts", "export default {}"],
    ["src/App.tsx", "old"],
  ]);

  it("skips files the sandbox already has with the same content", () => {
    expect(
      getChangedFiles([{ path: "vite.config.ts", content: "export default {}" }], synced),
    ).toEqual([]);
  });

  it("returns edited and new files", () => {
    expect(
      getChangedFiles(
        [
          { path: "vite.config.ts", content: "export default {}" },
          { path: "src/App.tsx", content: "new" },
          { path: "src/new.ts", content: "" },
        ],
        synced,
      ),
    ).toEqual([
      { path: "src/App.tsx", content: "new" },
      { path: "src/new.ts", content: "" },
    ]);
  });
});
