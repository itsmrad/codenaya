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
        page.getByRole("button", { name: "Start Building" }),
      ).toBeVisible();

      // The navbar collapses the sign-in CTA into a menu below the md breakpoint.
      if (viewport.width < 768) {
        await page.getByRole("button", { name: "Toggle menu" }).click();
      }
      await expect(
        page.getByRole("button", { name: "Log in" }).first(),
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
