import { describe, expect, it } from "vitest";

import { detectFramework, needsSandbox } from "./framework";

describe("detectFramework", () => {
  it.each(["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cts"])("detects vite from %s", (config) => {
    expect(detectFramework(["package.json", config])).toBe("vite");
  });

  it.each(["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"])("detects next from %s", (config) => {
    expect(detectFramework(["package.json", config])).toBe("next");
  });

  it("detects next from dependencies or devDependencies", () => {
    expect(detectFramework(["package.json"], { dependencies: { next: "^15.0.0" } })).toBe("next");
    expect(detectFramework(["package.json"], { devDependencies: { next: "15.0.0" } })).toBe("next");
  });

  it("prefers next when both are present", () => {
    expect(detectFramework(["package.json", "vite.config.ts", "next.config.ts"])).toBe("next");
    expect(detectFramework(["package.json", "vite.config.ts"], { dependencies: { next: "15" } })).toBe("next");
  });

  it("detects TanStack Start from its dependency before the Vite fallback", () => {
    const start = { dependencies: { "@tanstack/react-start": "^1.169.0", vite: "^8.0.0" } };
    expect(detectFramework(["package.json", "vite.config.ts"], start)).toBe("tanstack-start");
    expect(detectFramework(["package.json"], { devDependencies: { "@tanstack/react-start": "1" } })).toBe("tanstack-start");
    expect(detectFramework(["package.json", "vite.config.ts"], { ...start, devDependencies: { next: "15" } })).toBe("next");
  });

  it("uses Start's root route only when package.json wasn't parsed", () => {
    const paths = ["package.json", "vite.config.ts", "src/routes/__root.tsx"];
    expect(detectFramework(paths)).toBe("tanstack-start");
    expect(detectFramework(paths, null)).toBe("tanstack-start");
    // A plain TanStack Router SPA has the same root route but no Start dependency.
    expect(detectFramework(paths, { dependencies: { "@tanstack/react-router": "1" } })).toBe("vite");
    expect(detectFramework(["package.json", "src/routes/__root.tsx"])).toBeNull();
  });

  it("forces the sandbox for frameworks with their own server", () => {
    expect(needsSandbox("next")).toBe(true);
    expect(needsSandbox("tanstack-start")).toBe(true);
    for (const framework of ["vite", null, undefined] as const) expect(needsSandbox(framework)).toBe(false);
  });

  it("returns null without package.json or a framework", () => {
    expect(detectFramework(["vite.config.ts"])).toBeNull();
    expect(detectFramework(["next.config.ts"], { dependencies: { next: "15" } })).toBeNull();
    expect(detectFramework(["package.json", "src/main.tsx"], { dependencies: { react: "19" } })).toBeNull();
    expect(detectFramework(["package.json"])).toBeNull();
  });

  it("ignores configs that are not at the project root", () => {
    expect(detectFramework(["package.json", "app/vite.config.ts", "app/next.config.js"])).toBeNull();
  });

  it("accepts any iterable", () => {
    expect(detectFramework(new Set(["package.json", "vite.config.ts"]))).toBe("vite");
  });
});
