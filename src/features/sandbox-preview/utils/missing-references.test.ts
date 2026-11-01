import { describe, expect, it } from "vitest";

import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import {
  missingReferencedFiles,
  undeclaredPackages,
  unresolvedImports,
} from "./missing-references";

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
        ? { ...file, content: file.content.replace(/\s*"@tailwindcss\/vite": "[^"]+",?/, "") }
        : file,
    );
    expect(undeclaredPackages(files)).toEqual([
      "@tailwindcss/vite (imported by vite.config.ts)",
    ]);
  });

  it("names a package the starter's CSS imports after package.json dropped it (#331)", () => {
    const files = starter().map((file) =>
      file.path === "package.json"
        ? { ...file, content: file.content.replace(/\s*"tw-animate-css": "[^"]+",?/, "") }
        : file,
    );
    expect(undeclaredPackages(files)).toEqual(["tw-animate-css (imported by src/index.css)"]);
  });

  it("reads CSS @import and @plugin, skipping local files and URLs", () => {
    const files = withPackageJson({ devDependencies: { tailwindcss: "^4" } }, [
      {
        path: "src/styles/app.css",
        content: [
          '@import "tailwindcss";',
          '@import "theme.css";',
          '@import "./tokens.css";',
          '@import url("https://fonts.googleapis.com/css2?family=Inter");',
          '@import url("@fontsource/inter/400.css");',
          '@plugin "@tailwindcss/typography";',
          '/* @import "commented-out"; */',
        ].join("\n"),
      },
      { path: "src/styles/theme.css", content: "" },
      { path: "src/styles/tokens.css", content: "" },
    ]);
    expect(undeclaredPackages(files)).toEqual([
      "@fontsource/inter (imported by src/styles/app.css)",
      "@tailwindcss/typography (imported by src/styles/app.css)",
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

describe("unresolvedImports", () => {
  it("passes the agent's Vite + React starter", () => {
    expect(unresolvedImports(starter())).toEqual([]);
  });

  it("names a relative import with no file behind it", () => {
    const files = [
      ...starter(),
      { path: "src/pages/Home.tsx", content: 'import { Header } from "../components/Header";\n' },
    ];
    expect(unresolvedImports(files)).toEqual([
      "../components/Header (imported by src/pages/Home.tsx)",
    ]);
  });

  it("resolves extensions, index files, the @/ alias and query suffixes", () => {
    const files = [
      {
        path: "src/App.tsx",
        content: [
          'import "./index.css";',
          'import { Button } from "@/components/ui";',
          'import logo from "./logo.svg?url";',
          'const Page = lazy(() => import("./pages/Page"));',
          '// import { Gone } from "./gone";',
          'import { helper } from "./lib/helper.js";',
          "const messages = import(`./locales/${lang}.json`);",
        ].join("\n"),
      },
      { path: "src/index.css", content: "" },
      { path: "src/components/ui/index.ts", content: "" },
      { path: "src/pages/Page.tsx", content: "" },
      { path: "src/lib/helper.ts", content: "" },
    ];
    // The logo is an uploaded image: a known path without text content.
    const paths = new Set([...files.map((file) => file.path), "src/logo.svg"]);
    expect(unresolvedImports(files, paths)).toEqual([]);
  });

  it("names a missing @/ import", () => {
    const files = [{ path: "src/App.tsx", content: 'import { cn } from "@/lib/utils";\n' }];
    expect(unresolvedImports(files)).toEqual(["@/lib/utils (imported by src/App.tsx)"]);
  });
});
