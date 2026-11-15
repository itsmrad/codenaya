import { describe, expect, it } from "vitest";

import { getTemplateSeedFiles } from "./seed-files";
import { readTemplateSource } from "./server/template-source";
import { BRAND_COLORS, BRAND_FILE, BRAND_FILES, applyBrandOrNull, rewriteCopyPrompt, type BrandFiles } from "./make-it-mine";
import { STARTER_TEMPLATES } from "./templates";

const INSTANT = STARTER_TEMPLATES.filter((template) => template.instant);

const brandFilesOf = async (template: (typeof INSTANT)[number]) => {
  const files = getTemplateSeedFiles(template, await readTemplateSource(template.id));
  return Object.fromEntries(
    BRAND_FILES.map((path) => [path, files.find((file) => file.path === path)!.content]),
  ) as BrandFiles;
};

describe("applyBrandOrNull", () => {
  it.each(INSTANT)("$id applies a name and colour to its title, brand constant and tokens", async (template) => {
    const files = await brandFilesOf(template);
    const color = BRAND_COLORS[2].value;

    const next = applyBrandOrNull(files, { name: ' Crumb & "Co" ', color })!;

    expect(next["index.html"]).toContain('<title>Crumb &amp; "Co"</title>');
    expect(next[BRAND_FILE]).toContain('export const BRAND_NAME = "Crumb & \\"Co\\"";');
    const css = next["src/index.css"];
    // Both themes, and only the tokens themselves.
    expect(css.match(new RegExp(`--primary: ${color.replace(/[()]/g, "\\$&")};`, "g"))).toHaveLength(2);
    expect(css.match(new RegExp(`--ring: ${color.replace(/[()]/g, "\\$&")};`, "g"))).toHaveLength(2);
    expect(css).toContain("--color-primary: var(--primary);");
    expect(css).toContain("--sidebar-ring: oklch(0.704 0.04 256.788);");
  });

  it.each(INSTANT)("$id is unchanged with no input", async (template) => {
    const files = await brandFilesOf(template);
    expect(applyBrandOrNull(files, {})).toEqual(files);
    expect(applyBrandOrNull(files, { name: "  " })).toEqual(files);
  });

  it("keeps a name with replacement patterns literal", async () => {
    const next = applyBrandOrNull(await brandFilesOf(INSTANT[0]), { name: "$& $1" })!;
    expect(next[BRAND_FILE]).toContain('export const BRAND_NAME = "$& $1";');
    expect(next["index.html"]).toContain("<title>$&amp; $1</title>");
  });

  it("applies the name alone and leaves the colours", async () => {
    const files = await brandFilesOf(INSTANT[0]);
    const next = applyBrandOrNull(files, { name: "Acme" })!;
    expect(next[BRAND_FILE]).toContain('BRAND_NAME = "Acme"');
    expect(next["src/index.css"]).toBe(files["src/index.css"]);
  });

  it("returns null when a brand marker is gone", async () => {
    const files = await brandFilesOf(INSTANT[0]);
    expect(applyBrandOrNull({ ...files, [BRAND_FILE]: "export const NAME = 'x';" }, { name: "A" })).toBeNull();
    expect(applyBrandOrNull({ ...files, "index.html": "<html></html>" }, { name: "A" })).toBeNull();
  });

  it("asks for a copy rewrite that keeps the layout", () => {
    expect(rewriteCopyPrompt(" a bakery ")).toMatch(/^Rewrite the copy of this app for a bakery\. Keep the layout/);
  });
});

describe("instant templates", () => {
  it("are landing page and admin CRUD for now", () => {
    expect(INSTANT.map((template) => template.id)).toEqual(["landing-page", "admin-crud"]);
  });

  it.each(INSTANT)("$id seeds the starter config with its own app source", async (template) => {
    const files = getTemplateSeedFiles(template, await readTemplateSource(template.id));
    const app = files.find((file) => file.path === "src/App.tsx")!.content;

    expect(files.filter((file) => file.path === "src/App.tsx")).toHaveLength(1);
    expect(app).toContain('from "./brand"');
    expect(app).not.toContain(template.description);
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining(["package.json", "vite.config.ts", BRAND_FILE]));
  });
});
