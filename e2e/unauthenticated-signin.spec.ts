import { expect, test } from "@playwright/test";

import { collectConsoleErrors } from "./console-errors";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

// Any id works: signed-out visitors see the unauthenticated view before the
// project is looked up.
const PROJECT_PATH = "/projects/k57abc123def456ghi789jkl0mn1pqr2";

test.describe("unauthenticated project page", () => {
  for (const viewport of VIEWPORTS) {
    test(`opens the in-app sign-in modal on ${viewport.name} (${viewport.width}px)`, async ({ page, baseURL }) => {
      await page.setViewportSize(viewport);
      const errors = collectConsoleErrors(page);

      await page.goto(PROJECT_PATH);
      await page.getByRole("button", { name: "Sign in" }).click();

      await expect(page.locator(".cl-modalContent")).toBeVisible();
      expect(page.url()).toBe(`${baseURL}${PROJECT_PATH}`);

      expect(errors).toEqual([]);
    });
  }
});
