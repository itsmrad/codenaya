import { describe, expect, it, vi } from "vitest";

import { syntaxError, syntaxErrorNote } from "./syntax-error";

describe("syntaxError", () => {
  it("accepts valid TSX, TS and JSX", () => {
    expect(
      syntaxError(
        "App.tsx",
        'import type { ReactNode } from "react";\nexport default function App({ children }: { children: ReactNode }) {\n  return <main className="p-4">{children}</main>;\n}\n',
      ),
    ).toBeNull();
    expect(syntaxError("vite.config.ts", "export default { plugins: [] } satisfies object;\n")).toBeNull();
    expect(syntaxError("main.jsx", "createRoot(root).render(<App />);\n")).toBeNull();
  });

  it("reports the first error with its line and column", () => {
    // The live-run failure: a component's props type closed with the wrong brace.
    const source =
      "const a = 1;\nfunction Nav({ text }: { text: string ) {\n  return <a>{text}</a>;\n}\nexport default Nav;\n";
    expect(syntaxError("App.tsx", source)).toMatch(/^2:\d+ .+ expected\.$/);
  });

  it("catches unclosed JSX", () => {
    expect(syntaxError("App.tsx", "export const App = () => <div><span></div>;\n")).toMatch(
      /^1:\d+ /,
    );
  });

  it("ignores files that aren't scripts", () => {
    expect(syntaxError("index.css", "{{{")).toBeNull();
    expect(syntaxError("package.json", "{")).toBeNull();
  });
});

describe("syntaxErrorNote", () => {
  it("is empty when every file parses", () => {
    expect(syntaxErrorNote([{ name: "a.ts", content: "export {};" }])).toBe("");
  });

  it("names each broken file", () => {
    const note = syntaxErrorNote([
      { name: "ok.ts", content: "export {};" },
      { name: "App.tsx", content: "export default () => <div>;" },
    ]);
    expect(note).toContain("Syntax errors (the content was saved; fix it with editFile");
    expect(note).toContain("App.tsx 1:");
    expect(note).not.toContain("ok.ts");
  });

  it("skips a file TypeScript throws on and still checks the rest", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const note = syntaxErrorNote([
      { name: "types.d.ts", content: "export type A = 1;\n" },
      { name: "App.tsx", content: "export default () => <div>;" },
    ]);
    expect(note).toContain("App.tsx 1:");
    expect(note).not.toContain("types.d.ts");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
