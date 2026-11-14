import { describe, expect, it } from "vitest";

import { KNOWN_GOOD_VERSIONS } from "./known-good-versions";
import { VITE_REACT_STARTER } from "./vite-starter";

const COMPONENTS = [
  "button", "card", "input", "label", "textarea", "badge", "dialog",
  "dropdown-menu", "select", "tabs", "sheet", "separator", "skeleton",
  "tooltip", "avatar", "sonner",
];
const files = new Map(VITE_REACT_STARTER.map(({ path, content }) => [path, content]));
const pkg = JSON.parse(files.get("package.json")!);

describe("Vite starter UI (#294)", () => {
  it("ships every common primitive and mounts one Sonner toaster", () => {
    expect(new Set(VITE_REACT_STARTER.map(({ path }) => path)).size).toBe(VITE_REACT_STARTER.length);
    for (const name of COMPONENTS) {
      expect(files.get(`src/components/ui/${name}.tsx`)).toMatch(/export /);
    }
    expect(files.get("src/main.tsx")?.match(/<Toaster \/>/g)).toHaveLength(1);
    expect(files.get("src/components/ui/sonner.tsx")).not.toContain("next-themes");
  });

  it("resolves every shipped UI import and pins and prebundles its dependencies", () => {
    for (const name of COMPONENTS) {
      const source = files.get(`src/components/ui/${name}.tsx`)!;
      for (const [, specifier] of source.matchAll(/from "([^"]+)"/g)) {
        if (specifier.startsWith("@/")) {
          const path = specifier.replace("@/", "src/");
          expect(files.has(`${path}.ts`) || files.has(`${path}.tsx`), specifier).toBe(true);
        } else {
          expect(pkg.dependencies[specifier], specifier).toBe(
            KNOWN_GOOD_VERSIONS[specifier as keyof typeof KNOWN_GOOD_VERSIONS],
          );
          expect(pkg.dependencies[specifier], specifier).toBeTruthy();
          if (specifier !== "react") {
            expect(files.get("vite.config.ts"), specifier).toContain(`"${specifier}"`);
          }
        }
      }
    }
  });

  it("defines light and dark values for the v4 theme's semantic color utilities", () => {
    const css = files.get("src/index.css")!;
    for (const [, token] of css.matchAll(/--color-[\w-]+: var\(--([\w-]+)\)/g)) {
      expect(css.match(new RegExp(`--${token}:`, "g")), token).toHaveLength(2);
    }
    for (const name of COMPONENTS) {
      expect(files.get(`src/components/ui/${name}.tsx`)).not.toMatch(/hsl\(var\(--|from "(?:cn|radix-ui)"|@\/registry\//);
    }
  });
});
