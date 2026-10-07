import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.describe("not-found page", () => {
  for (const viewport of VIEWPORTS) {
    test(`renders a themed 404 on ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors = collectConsoleErrors(page);

      const response = await page.goto("/this-page-does-not-exist");
      expect(response?.status()).toBe(404);

      await expect(
        page.getByRole("heading", { level: 1, name: "Page not found" }),
      ).toBeVisible();

      const background = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      expect(background).not.toBe("rgb(0, 0, 0)");

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "horizontal overflow in px").toBe(0);

      await page.waitForLoadState("networkidle");
      // The browser logs the document's own 404 response as a failed load.
      expect(errors.filter((error) => !error.includes("status of 404"))).toEqual([]);

      await page.getByRole("link", { name: "Back to home" }).click();
      await expect(page).toHaveURL("/");
    });
  }

  test("shows a friendly state for a missing project", async ({ page }) => {
    test.skip(
      !hasClerkCredentials(),
      "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
    test.setTimeout(120_000);

    await signIn(page);
    await page.goto("/projects/does-not-exist");

    await expect(
      page.getByRole("heading", { level: 1, name: "Project not found" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to home" })).toBeVisible();
  });
});
