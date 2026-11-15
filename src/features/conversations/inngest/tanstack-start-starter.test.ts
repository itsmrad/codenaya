import { describe, expect, it } from "vitest";

import { TANSTACK_START_STARTER, wantsTanStackStart } from "./tanstack-start-starter";
import { INDEX_CSS, UTILS_TS, VITE_DEPENDENCIES, VITE_DEV_DEPENDENCIES } from "./vite-starter";
import { VITE_STARTER_UI } from "./vite-starter-ui";

const files = new Map(TANSTACK_START_STARTER.map(({ path, content }) => [path, content]));
const pkg = JSON.parse(files.get("package.json")!);

describe("TanStack Start starter", () => {
  it("ships Start's entry points without the SPA's index.html, main.tsx or router", () => {
    expect(files.size).toBe(TANSTACK_START_STARTER.length);
    for (const path of ["vite.config.ts", "tsconfig.json", "src/router.tsx", "src/routeTree.gen.ts", "src/routes/__root.tsx", "src/routes/index.tsx"]) {
      expect(files.has(path), path).toBe(true);
    }
    for (const path of ["index.html", "src/main.tsx", "src/App.tsx", "src/index.css", "tsconfig.app.json", "next.config.ts"]) {
      expect(files.has(path), path).toBe(false);
    }
    expect(pkg.scripts).toEqual({ dev: "vite dev", build: "vite build" });
    expect(Object.keys(pkg.dependencies).join(" ")).not.toMatch(/react-router-dom|nitro|^next$/);
  });

  it("uses exact pins, with the Vite starter's toolchain", () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.devDependencies).toEqual(VITE_DEV_DEPENDENCIES);
    expect(pkg.dependencies["@fontsource/inter"]).toBe(VITE_DEPENDENCIES["@fontsource/inter"]);
  });

  it("puts the Start plugin before React, then Tailwind, on port 3000", () => {
    const config = files.get("vite.config.ts")!;
    expect(config).toContain('from "@tanstack/react-start/plugin/vite"');
    expect(config).toContain("plugins: [tanstackStart(), viteReact(), tailwindcss()]");
    expect(config).toContain("server: { port: 3000 }");
    expect(config).toContain("tsconfigPaths: true");
    const tsconfig = JSON.parse(files.get("tsconfig.json")!).compilerOptions;
    expect(tsconfig).toMatchObject({ jsx: "react-jsx", paths: { "@/*": ["./src/*"] } });
    expect(tsconfig.verbatimModuleSyntax).toBeUndefined();
    expect(JSON.parse(files.get("components.json")!)).toMatchObject({ rsc: false, tailwind: { css: "src/styles/app.css" } });
  });

  it("renders the document shell with one toaster, an error card and the ?url stylesheet", () => {
    const root = files.get("src/routes/__root.tsx")!;
    for (const part of ["<HeadContent />", "<Scripts />", "errorComponent: RootError", 'from "../styles/app.css?url"', 'from "@fontsource/inter/400.css?url"']) {
      expect(root, part).toContain(part);
    }
    expect(root.match(/<Toaster \/>/g)).toHaveLength(1);
    expect(files.get("src/routes/index.tsx")).toContain('createFileRoute("/")');
    expect(files.get("src/routeTree.gen.ts")).toContain("routeTree");
    expect(files.get("src/router.tsx")).toContain("export function getRouter()");
  });

  it("reuses the design tokens, utilities and UI", () => {
    expect(files.get("src/styles/app.css")).toBe(INDEX_CSS);
    expect(files.get("src/lib/utils.ts")).toBe(UTILS_TS);
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

describe("wantsTanStackStart", () => {
  it.each(["Use TanStack Start", "build it with tanstack start", "a Tan Stack Start app", "TANSTACK  START dashboard", "install @tanstack/react-start", "a tanstack-start app", "TanStackStart"])("recognises %s", (prompt) => {
    expect(wantsTanStackStart(prompt)).toBe(true);
  });

  it.each(["Use TanStack Query", "a TanStack Table grid", "tanstack router", "tanstack", "start the dashboard", "tanstack starter kit", "tanstackstarter", "tanstack-query", "@tanstack/react-query", ""])("ignores %s", (prompt) => {
    expect(wantsTanStackStart(prompt)).toBe(false);
  });
});
