import { expect, test } from "@playwright/test";

import { collectConsoleErrors } from "./console-errors";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.describe("landing page", () => {
  for (const viewport of VIEWPORTS) {
    test(`renders without errors or overflow on ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors = collectConsoleErrors(page);

      await page.goto("/");

      await expect(
        page.getByRole("heading", { level: 1, name: "Build with AI." }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Start Building" }),
      ).toBeVisible();

      // The navbar collapses the sign-in CTA into a menu below the md breakpoint.
      if (viewport.width < 768) {
        await page.getByRole("button", { name: "Toggle menu" }).click();
      }
      await expect(
        page.getByRole("link", { name: "Log in" }).first(),
      ).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "horizontal overflow in px").toBe(0);

      await page.waitForLoadState("networkidle");
      expect(errors).toEqual([]);
    });
  }
});

test.describe("landing layout", () => {
  test("stacks equal-width hero CTAs below the header on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");

    const header = await page.locator("header").boundingBox();
    const badge = await page.getByText("AI-Powered Browser IDE").boundingBox();
    expect(badge!.y - (header!.y + header!.height)).toBeGreaterThanOrEqual(24);

    const start = await page.getByRole("link", { name: "Start Building" }).boundingBox();
    const github = await page.getByRole("button", { name: "View on GitHub" }).boundingBox();
    expect(Math.abs(start!.width - github!.width)).toBeLessThanOrEqual(1);
  });

  test("shows the features as two equal columns on tablet", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");

    const titles = page.locator("section h3").filter({
      hasText: /AI Code Generation|In-Browser Execution|GitHub Integration|Real-time Collaboration/,
    });
    await expect(titles).toHaveCount(4);

    const boxes = await titles.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
        return { left: Math.round(rect.left), lines: Math.round(rect.height / lineHeight) };
      }),
    );
    expect(new Set(boxes.map((box) => box.left)).size).toBe(2);
    expect(boxes.every((box) => box.lines === 1)).toBe(true);
  });
});
