import { describe, expect, it } from "vitest";

import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import { missingReferencedFiles } from "./missing-references";

const starter = () => VITE_REACT_STARTER.map((file) => ({ ...file }));
const without = (path: string) => starter().filter((file) => file.path !== path);

describe("missingReferencedFiles", () => {
  it("passes the agent's Vite + React starter", () => {
    expect(missingReferencedFiles(starter())).toEqual([]);
  });

  it("names a tsconfig reference the project doesn't contain", () => {
    expect(missingReferencedFiles(without("tsconfig.app.json"))).toEqual([
      "tsconfig.app.json (referenced by tsconfig.json)",
    ]);
  });

  it("names a missing index.html entry script", () => {
    expect(missingReferencedFiles(without("src/main.tsx"))).toEqual([
      "src/main.tsx (referenced by index.html)",
    ]);
  });

  it("reads JSONC tsconfigs with comments and trailing commas", () => {
    const files = [
      {
        path: "tsconfig.json",
        content: `{
  // Project references
  "extends": "./tsconfig.base.json",
  "references": [{ "path": "./tsconfig.node.json" }, /* app */ { "path": "./packages/web" },],
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
}`,
      },
      { path: "tsconfig.node.json", content: "{}" },
    ];
    expect(missingReferencedFiles(files)).toEqual([
      "tsconfig.base.json (referenced by tsconfig.json)",
      "packages/web/tsconfig.json (referenced by tsconfig.json)",
    ]);
  });

  it("ignores package extends, remote scripts and public/ assets", () => {
    const files = [
      { path: "tsconfig.json", content: '{ "extends": "@tsconfig/vite-react/tsconfig.json" }' },
      {
        path: "index.html",
        content:
          '<script src="https://cdn.example.com/x.js"></script><script src="/vendor.js"></script>',
      },
      { path: "public/vendor.js", content: "" },
    ];
    expect(missingReferencedFiles(files)).toEqual([]);
  });

  it("stays out of the way when a config can't be parsed", () => {
    expect(missingReferencedFiles([{ path: "tsconfig.json", content: "{ nope" }])).toEqual([]);
  });
});
