import { describe, expect, it } from "vitest";
import { projectChecks, projectCheckNote, rewriteIcons } from "./project-checks";

const pkg = (dependencies = {}) => ({ path: "package.json", content: JSON.stringify({ dependencies }) });
const file = (path: string, content: string) => ({ path, content });
describe("project checks", () => {
  it("reports missing imports, undeclared packages and invalid icons", () => {
    const findings = projectChecks([pkg(), file("src/App.tsx", 'import { VercelLogo } from "lucide-react"; import x from "./missing";')]);
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
    expect(projectChecks([pkg({ tailwindcss: "^" + version + ".0.0" }), file("src/style.css", css)])[0].message).toContain(message);
  });
  it("flags v4 config/plugins and v3 Vite integration", () => {
    expect(projectChecks([pkg({ tailwindcss: "4.0.0", "tailwindcss-animate": "1" }), file("tailwind.config.ts", "export default {}")])).toHaveLength(2);
    expect(projectChecks([pkg({ tailwindcss: "3.0.0", "@tailwindcss/vite": "4" })])[0].checkId).toBe("tailwind");
  });
  it("does not flag comments, valid imports, or matching CSS", () => {
    expect(projectChecks([pkg({ tailwindcss: "^4.0.0", "lucide-react": "0.468.0" }), file("a.ts", '// import { Nope } from "lucide-react";\nimport { Camera } from "lucide-react";'), file("a.css", '@import "tailwindcss";')])).toEqual([]);
    expect(projectCheckNote([])).toBe("");
  });
  it("marks Next local/Tailwind checks as not checked but still checks packages", () => {
    const findings = projectChecks([pkg({ next: "15", tailwindcss: "4" }), file("a.ts", 'import x from "./missing"; import y from "missing";'), file("a.css", "@tailwind base;")]);
    expect(findings.map((f) => f.checkId)).toEqual(["package", "framework"]);
  });
  it("bounds work and handles malformed manifests without throwing", () => {
    expect(projectChecks([file("package.json", "{")])[0].checkId).toBe("unavailable");
    expect(projectChecks([file("big.ts", "x".repeat(100_001))])[0].checkId).toBe("limit");
    expect(projectChecks(Array.from({ length: 501 }, (_, i) => file(i + ".ts", "")))[0].checkId).toBe("limit");
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
  it("rewrites only a unique one-character typo, preserving local aliases", () => {
    expect(rewriteIcons('import { Cammera, Cammera as Photo } from "lucide-react";')).toEqual({
      content: 'import { Camera as Cammera, Camera as Photo } from "lucide-react";',
      rewrites: ["Cammera → Camera as Cammera", "Cammera → Camera as Photo"],
    });
  });
  it("leaves valid, distant, ambiguous, and non-lucide imports alone", () => {
    for (const text of ['import { Camera, VercelLogo, ArrowDown0 } from "lucide-react";', 'import { Cammera } from "other";', '// import { Cammera } from "lucide-react";']) {
      expect(rewriteIcons(text)).toEqual({ content: text, rewrites: [] });
    }
  });
});
