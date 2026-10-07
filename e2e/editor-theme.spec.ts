import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-editor-theme";
const FILE_NAME = "math.ts";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

/** Reuses (or creates) the e2e user's fixture project with one file that has every common token kind. */
const seedProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === PROJECT_NAME,
  );
  const projectId =
    existing?._id ?? (await user.mutation(api.projects.create, { name: PROJECT_NAME }));

  const system = new ConvexHttpClient(convexUrl!);
  await system.mutation(api.system.cleanup, { internalKey: internalKey!, projectId });
  await system.mutation(api.system.createFile, {
    internalKey: internalKey!,
    projectId,
    name: FILE_NAME,
    content:
      '// adds numbers\nimport { x } from "./x";\n\nexport function add(a: number, b: number): number {\n  const label = "sum";\n  return a + b + 42 + x.length;\n}\n',
  });

  return projectId;
};

/** Switches the theme in place, the way another tab or the Settings page does (next-themes listens for this). */
const switchTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((value) => {
    localStorage.setItem("theme", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: value }));
  }, theme);

/**
 * WCAG contrast of every text node in `selector` against the first opaque
 * background behind it. Returns the lowest ratio and the text colours seen.
 */
const textContrast = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const background = (element: Element | null): number[] => {
      for (let node = element; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length < 4 || color[3] === 1) return color.slice(0, 3);
      }
      return [255, 255, 255];
    };

    const root = document.querySelector(sel)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const ratios: number[] = [];
    const colors = new Set<string>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement!;
      if (!node.textContent?.trim()) continue;
      const color = getComputedStyle(element).color;
      const [fg, bg] = [luminance(rgb(color)), luminance(background(element))];
      ratios.push((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05));
      colors.add(color);
    }
    return { min: Math.min(...ratios), colors: [...colors] };
  }, selector);

test.describe("editor and terminal theme", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("code and terminal follow the app theme with readable contrast", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    // Keep the preview from booting a real sandbox; the terminal still renders.
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({ status: 503, json: { error: "Sandbox stubbed for e2e.", code: "config" } }),
    );

    await signIn(page);
    const projectId = await seedProject(page);
    await switchTheme(page, "light");

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("button", { name: FILE_NAME, exact: true }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("return a + b");

    // Light theme: every token passes WCAG AA and the editor is not One Dark.
    const light = await textContrast(page, ".cm-content");
    expect(light.colors).not.toContain("rgb(171, 178, 191)");
    expect(light.colors.length).toBeGreaterThan(4);
    expect(light.min).toBeGreaterThanOrEqual(4.5);

    // The selection tooltip uses the popover tokens.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    const tooltip = page.locator(".cm-tooltip").filter({ hasText: "Add to Chat" });
    await expect(tooltip).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect((await textContrast(page, ".cm-tooltip")).min).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("ArrowDown");

    // Switching theme re-themes the open editor without a reload.
    await switchTheme(page, "dark");
    await expect
      .poll(async () => (await textContrast(page, ".cm-content")).colors)
      .toContain("rgb(171, 178, 191)");
    expect((await textContrast(page, ".cm-content")).min).toBeGreaterThanOrEqual(4.5);

    // The preview terminal follows the theme too.
    await page.getByRole("tab", { name: "Preview" }).click();
    const rows = page.locator(".xterm-rows");
    await expect(rows).toHaveCSS("color", "rgb(255, 255, 255)");
    await switchTheme(page, "light");
    await expect(rows).toHaveCSS("color", "rgb(56, 58, 66)");

    expect(errors.filter((error) => !/status of 503 .*\/api\/sandbox/.test(error))).toEqual([]);
  });
});
