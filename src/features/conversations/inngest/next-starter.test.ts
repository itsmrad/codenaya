import { major, minVersion } from "semver";
import { describe, expect, it } from "vitest";

import { KNOWN_GOOD_VERSIONS } from "./known-good-versions";
import { NEXT_APP_STARTER, wantsNextJs } from "./next-starter";
import { INDEX_CSS, UTILS_TS } from "./vite-starter";
import { VITE_STARTER_UI } from "./vite-starter-ui";

const files = new Map(NEXT_APP_STARTER.map(({ path, content }) => [path, content]));
const pkg = JSON.parse(files.get("package.json")!);

describe("Next App Router starter", () => {
  it("ships a complete Next entry point without Vite files or dependencies", () => {
    expect(files.size).toBe(NEXT_APP_STARTER.length);
    for (const path of ["next.config.ts", "next-env.d.ts", "tsconfig.json", "postcss.config.mjs", "src/app/layout.tsx", "src/app/page.tsx", "src/app/error.tsx"]) {
      expect(files.has(path), path).toBe(true);
    }
    for (const path of ["vite.config.ts", "index.html", "src/main.tsx", "src/vite-env.d.ts", "tsconfig.app.json", "tsconfig.node.json"]) {
      expect(files.has(path), path).toBe(false);
    }
    expect(pkg.scripts).toEqual({ dev: "next dev", build: "next build", start: "next start" });
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(" ")).not.toMatch(/vite|react-router/);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      // Exact, on the known-good major: a range can resolve past a stale npm cache (ETARGET).
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(major(version as string), name).toBe(minVersion(KNOWN_GOOD_VERSIONS[name as keyof typeof KNOWN_GOOD_VERSIONS])!.major);
    }
    expect(pkg.devDependencies["@tailwindcss/postcss"]).toBe(pkg.devDependencies.tailwindcss);
    expect(pkg.devDependencies.postcss).toBeTruthy();
    expect(files.get("postcss.config.mjs")).toContain('"@tailwindcss/postcss"');
    expect(JSON.parse(files.get("tsconfig.json")!).compilerOptions).toMatchObject({
      paths: { "@/*": ["./src/*"] }, plugins: [{ name: "next" }], jsx: "react-jsx",
    });
    expect(JSON.parse(files.get("components.json")!)).toMatchObject({ rsc: true, tailwind: { css: "src/app/globals.css" } });
  });

  it("reuses design tokens, utilities and UI, with a client error boundary and one toaster", () => {
    expect(files.get("src/app/globals.css")).toBe(INDEX_CSS);
    expect(files.get("src/lib/utils.ts")).toBe(UTILS_TS);
    expect(files.get("src/app/layout.tsx")?.match(/<Toaster \/>/g)).toHaveLength(1);
    expect(files.get("src/app/layout.tsx")).toContain("export const metadata");
    expect(files.get("src/app/error.tsx")).toMatch(/^"use client"/);
    for (const { path, content } of VITE_STARTER_UI) {
      expect(files.get(path)).toBe(content);
      for (const [, specifier] of content.matchAll(/from "([^"]+)"/g)) {
        if (specifier.startsWith("@/")) {
          const local = specifier.replace("@/", "src/");
          expect(files.has(`${local}.ts`) || files.has(`${local}.tsx`), specifier).toBe(true);
        } else {
          expect(pkg.dependencies[specifier], specifier).toBeTruthy();
        }
      }
    }
  });
});

describe("wantsNextJs", () => {
  it.each(["Use Next.js", "build with NEXTJS", "Use Next JS", "a next 15 app", "next 15 App Router", "Use the App Router", "(Next.js) dashboard", "Next.js 15 App Router", "a next 16 app", "Next.js 16 App Router"])("recognises %s", (prompt) => {
    expect(wantsNextJs(prompt)).toBe(true);
  });

  it.each(["Build a dashboard", "Use Vite", "what is the next step?", "next steps", "next 15 items", "next 15 minutes", "the next 15 days", "next 15", "next 150", "next 16 items", "mynextjsapp", "app routers", "next.jsx", ""])("keeps Vite for %s", (prompt) => {
    expect(wantsNextJs(prompt)).toBe(false);
  });
});
