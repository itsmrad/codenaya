import { describe, expect, it } from "vitest";
import { stripComments } from "./missing-references";
import { projectChecks, projectCheckNote, rewriteIcons } from "./project-checks";

const pkg = (dependencies: Record<string, string> = { "lucide-react": "^1.66.0" }) => ({ path: "package.json", content: JSON.stringify({ dependencies }) });
const file = (path: string, content: string) => ({ path, content });
describe("project checks", () => {
  it("reports missing imports, undeclared packages and invalid icons", () => {
    const findings = projectChecks([pkg(), file("src/App.tsx", 'import { VercelLogo } from "lucide-react"; import x from "./missing"; import y from "missing-package";')]);
    expect(findings.map((f) => f.checkId)).toEqual(expect.arrayContaining(["package", "import", "icon"]));
    expect(projectCheckNote(findings).match(/Project checks/g)).toHaveLength(1);
  });
  it("checks importers of the changed file, aliases, reexports and default exports", () => {
    const findings = projectChecks([
      pkg(), file("src/ui.ts", "export const Button = 1; export { Button as Link };"),
      file("src/App.tsx", 'import Thing, { Dialog, Link as L } from "@/ui";'),
      file("unrelated.ts", 'import x from "./missing";'),
    ], undefined, new Set(["src/ui.ts"]));
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain("Dialog");
    expect(findings[1].message).toContain("default export");
  });
  it("skips uncertain barrels and CommonJS, and accepts type exports", () => {
    expect(projectChecks([
      pkg(), file("a.ts", 'export * from "./b";'), file("b.ts", "export interface B {}"),
      file("c.ts", 'import { X } from "./a"; import { B as Bee } from "./b";'),
    ])).toEqual([]);
  });
  it.each([
    ["4", "@tailwind utilities;", 'replace v3 @tailwind'],
    ["3", '@import "tailwindcss"; @theme {} @plugin "x"; @custom-variant dark;', "Tailwind v3"],
  ])("detects Tailwind drift for v%s", (version, css, message) => {
    expect(projectChecks([pkg({ tailwindcss: "^" + version + ".0.0" }), file("src/style.css", css)]).find((finding) => finding.checkId === "tailwind")?.message).toContain(message);
  });
  it("flags v4 config/plugins and v3 Vite integration", () => {
    expect(projectChecks([pkg({ tailwindcss: "4.0.0", "tailwindcss-animate": "1" }), file("tailwind.config.ts", "export default {}")])).toHaveLength(2);
    expect(projectChecks([pkg({ tailwindcss: "3.0.0", "@tailwindcss/vite": "4" })])[0].checkId).toBe("tailwind");
  });
  it("does not flag comments, valid imports, or matching CSS", () => {
    expect(projectChecks([pkg({ tailwindcss: "^4.0.0", "lucide-react": "0.468.0" }), file("a.ts", '// import { Nope } from "lucide-react";\nimport { Camera } from "lucide-react";'), file("a.css", '@import "tailwindcss";')])).toEqual([]);
    expect(projectCheckNote([])).toBe("");
  });
  it("resolves a CSS import of an untouched sibling file, not as a package", () => {
    expect(projectChecks([
      pkg({ tailwindcss: "^4.0.0" }), file("src/index.css", '@import "tailwindcss";\n@import "theme.css";'), file("src/theme.css", ":root {}"),
    ], undefined, new Set(["src/index.css"]))).toEqual([]);
  });
  it("silently skips Next local/Tailwind checks but still checks packages", () => {
    const findings = projectChecks([pkg({ next: "15", tailwindcss: "4" }), file("a.ts", 'import x from "./missing"; import y from "missing";'), file("a.css", "@tailwind base;")]);
    expect(findings.map((f) => f.checkId)).toEqual(["package"]);
  });
  it("bounds work and handles malformed manifests without throwing", () => {
    expect(projectChecks([file("package.json", "{")])).toEqual([]);
    expect(projectChecks([file("big.ts", "x".repeat(100_001))])).toEqual([]);
    expect(projectChecks(Array.from({ length: 501 }, (_, i) => file(i + ".ts", "")))).toEqual([]);
  });
  it("finishes a 100-file project within 50ms", () => {
    const files = [pkg(), ...Array.from({ length: 99 }, (_, i) => file(i + ".ts", "export const A = 1;"))];
    projectChecks(files);
    const start = performance.now();
    projectChecks(files);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("icon rewrites", () => {
  it.each(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "mdx"])("checks and repairs icons in .%s files only", (extension) => {
    const source = 'import { Cammera } from "lucide-react";';
    expect(rewriteIcons(source, "^1.66.0", `a.${extension}`).content).toContain("Camera as Cammera");
    expect(projectChecks([pkg(), file(`a.${extension}`, source)])[0].checkId).toBe("icon");
  });
  it("leaves Markdown imports untouched and skips icon findings", () => {
    const source = 'import { Cammera } from "lucide-react";';
    expect(rewriteIcons(source, "^1.66.0", "README.md")).toEqual({ content: source, rewrites: [] });
    expect(projectChecks([pkg(), file("README.md", source)])).toEqual([]);
  });

  it("rewrites only a unique one-character typo, preserving local aliases", () => {
    expect(rewriteIcons('import { Cammera, Cammera as Photo } from "lucide-react";', "^1.66.0", "a.tsx")).toEqual({
      content: 'import { Camera as Cammera, Camera as Photo } from "lucide-react";',
      rewrites: ["Cammera → Camera as Cammera", "Cammera → Camera as Photo"],
    });
  });
  it("leaves valid, distant, ambiguous, and non-lucide imports alone", () => {
    for (const text of ['import { Camera, VercelLogo, ArrowDown0 } from "lucide-react";', 'import { Cammera } from "other";', '// import { Cammera } from "lucide-react";']) {
      expect(rewriteIcons(text, "^1.66.0", "a.tsx")).toEqual({ content: text, rewrites: [] });
    }
  });
});

describe("review regressions", () => {
  it("pins the catalog to v1 and includes type-only exports", () => {
    const source = 'import { BeefOff, HeartX, Github } from "lucide-react"; import type { IconNode, LucideIcon, LucideProps, SVGAttributes } from "lucide-react";';
    const findings = projectChecks([pkg(), file("a.ts", source)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('"Github"');
    expect(rewriteIcons(source, "^1.66.0", "a.tsx")).toEqual({ content: source, rewrites: [] });
  });
  it.each([undefined, "^0.562.0", "^2.0.0", "latest", "^1 || ^2"])("silently skips icon checks and repairs for %s", (range) => {
    const source = 'import { Cammera, Github } from "lucide-react";';
    expect(rewriteIcons(source, range, "a.tsx")).toEqual({ content: source, rewrites: [] });
    const findings = projectChecks([pkg({ "lucide-react": range ?? "*" }), file("a.ts", source)]);
    expect(findings).toEqual([]);
  });
  it("preserves the inline type keyword in a repaired import", () => {
    expect(rewriteIcons('import { type Cammera as Photo } from "lucide-react";', "^1.66.0", "a.tsx").content)
      .toBe('import { type Camera as Photo } from "lucide-react";');
  });
  it("checks remaining files when one file exceeds the size limit", () => {
    expect(projectChecks([file("huge.ts", "x".repeat(100_001)), file("a.ts", 'import x from "./missing";')])[0].checkId).toBe("import");
  });
  it("accepts explicit Tailwind v4 legacy compatibility directives", () => {
    expect(projectChecks([
      pkg({ tailwindcss: "^4.3.0", "tailwindcss-animate": "1" }),
      file("tailwind.config.ts", "export default {}"),
      file("style.css", '@config "./tailwind.config.ts"; @plugin "tailwindcss-animate";'),
    ])).toEqual([]);
  });
  it("recognizes abstract classes, const enums, generators and dollar identifiers", () => {
    expect(projectChecks([
      file("target.ts", "export abstract class Base {} export const enum Color { Red } export function* values() {} export const $value = 1;"),
      file("a.ts", 'import { Base, Color, values, $value } from "./target";'),
    ])).toEqual([]);
  });
  it("skips malformed or uncertain export targets", () => {
    expect(projectChecks([file("target.ts", "export const { x } = data;"), file("a.ts", 'import { X } from "./target";')])).toEqual([]);
    expect(projectChecks([file("target.ts", "export const x = {"), file("a.ts", 'import { X } from "./target";')])).toEqual([]);
  });
  it("preserves URLs in strings and JSX text, including text with apostrophes", () => {
    const source = `const view = <p>Here's http://example.test</p>;
export const url = "http://example.test"; // actual comment
export const other = 'http://example.test';`;
    expect(stripComments(source)).toContain('export const url = "http://example.test";');
    expect(stripComments(source)).toContain("Here's http://example.test</p>");
    expect(stripComments(source)).not.toContain("actual comment");
    expect(projectChecks([file("target.tsx", source), file("a.ts", 'import { url, other } from "./target";')])).toEqual([]);
  });
});
