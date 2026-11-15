import { describe, expect, it } from "vitest";

import { detectFramework } from "./framework";

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
