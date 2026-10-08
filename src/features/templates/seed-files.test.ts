import { describe, expect, it } from "vitest";

import { getTemplateSeedFiles, planSeedTree } from "./seed-files";
import { STARTER_TEMPLATES, STARTER_TEMPLATE_IDS, getStarterTemplate } from "./templates";

describe("starter templates", () => {
  it("has six templates with unique ids", () => {
    expect(STARTER_TEMPLATES).toHaveLength(6);
    expect(new Set(STARTER_TEMPLATE_IDS).size).toBe(6);
    expect(getStarterTemplate("blog")?.title).toBe("Blog");
    expect(getStarterTemplate("nope")).toBeUndefined();
  });

  it.each(STARTER_TEMPLATES)("$id seeds a Vite app that runs with npm run dev", (template) => {
    const files = getTemplateSeedFiles(template);
    const paths = files.map((f) => f.path);

    expect(paths).toEqual(
      expect.arrayContaining(["package.json", "index.html", "src/main.tsx", "src/App.tsx"]),
    );
    const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content);
    expect(pkg.name).toBe(template.id);
    expect(pkg.scripts.dev).toBe("vite");
    expect(files.find((f) => f.path === "src/App.tsx")!.content).toContain(template.title);
  });
});

describe("planSeedTree", () => {
  it("creates parent folders first and groups files by folder", () => {
    const { folders, filesByFolder } = planSeedTree([
      { path: "src/components/ui/button.tsx", content: "b" },
      { path: "package.json", content: "p" },
      { path: "src/main.tsx", content: "m" },
      { path: "src/App.tsx", content: "a" },
    ]);

    expect(folders).toEqual(["src", "src/components", "src/components/ui"]);
    expect(filesByFolder.get("")).toEqual([{ name: "package.json", content: "p" }]);
    expect(filesByFolder.get("src")).toEqual([
      { name: "main.tsx", content: "m" },
      { name: "App.tsx", content: "a" },
    ]);
    expect(filesByFolder.get("src/components/ui")).toEqual([{ name: "button.tsx", content: "b" }]);
    expect(filesByFolder.has("src/components")).toBe(false);
  });
});
