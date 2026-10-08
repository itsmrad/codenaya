import { describe, expect, it } from "vitest";

import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import { missingReferencedFiles, undeclaredPackages } from "./missing-references";

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

describe("undeclaredPackages", () => {
  const withPackageJson = (pkg: object, files: { path: string; content: string }[]) => [
    { path: "package.json", content: JSON.stringify(pkg) },
    ...files,
  ];

  it("passes the agent's Vite + React starter", () => {
    expect(undeclaredPackages(starter())).toEqual([]);
  });

  it("names a package a config imports after package.json dropped it", () => {
    const files = starter().map((file) =>
      file.path === "package.json"
        ? { ...file, content: file.content.replace(/\s*"tailwindcss-animate": "[^"]+",?/, "") }
        : file,
    );
    expect(undeclaredPackages(files)).toEqual([
      "tailwindcss-animate (imported by tailwind.config.ts)",
    ]);
  });

  it("reads package names from subpaths, scopes, dynamic imports and require", () => {
    const files = withPackageJson({ dependencies: { react: "18" } }, [
      {
        path: "src/main.tsx",
        content: [
          'import { createRoot } from "react-dom/client";',
          'import "@fontsource/inter/400.css";',
          'const Chart = lazy(() => import("recharts"));',
          'const x = require("lodash/merge");',
          'import React from "react";',
        ].join("\n"),
      },
    ]);
    expect(undeclaredPackages(files)).toEqual([
      "react-dom (imported by src/main.tsx)",
      "@fontsource/inter (imported by src/main.tsx)",
      "recharts (imported by src/main.tsx)",
      "lodash (imported by src/main.tsx)",
    ]);
  });

  it("ignores relative paths, aliases, builtins, comments and workspace packages", () => {
    const files = withPackageJson({}, [
      {
        path: "src/App.tsx",
        content: [
          'import { cn } from "@/lib/utils";',
          'import Button from "./Button";',
          'import { fileURLToPath } from "node:url";',
          'import path from "path";',
          'import icon from "/vite.svg";',
          '// import { motion } from "framer-motion";',
          'const url = "https://example.com"; // from "nowhere"',
        ].join("\n"),
      },
      { path: "src/vite-env.d.ts", content: 'declare module "untyped" { import x from "y"; }' },
      { path: "packages/web/package.json", content: "{}" },
      { path: "packages/web/src/index.ts", content: 'import z from "zod";' },
    ]);
    expect(undeclaredPackages(files)).toEqual([]);
  });

  it("stays out of the way without a readable package.json", () => {
    const files = [{ path: "src/main.tsx", content: 'import "react";' }];
    expect(undeclaredPackages(files)).toEqual([]);
    expect(undeclaredPackages([{ path: "package.json", content: "{ nope" }, ...files])).toEqual([]);
  });
});
