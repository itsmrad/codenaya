import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

test.describe("signed-in dashboard layout", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  for (const width of [375, 768, 1440]) {
    test(`fits the viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors = collectConsoleErrors(page);
      await signIn(page);
      await page.goto("/");

      const heading = page.getByRole("heading", { name: "What will you build?" });
      await expect(heading).toBeVisible();
      // The hero must get most of the viewport, not be squeezed by the sidebar.
      const box = await heading.boundingBox();
      expect(box!.width).toBeGreaterThan(Math.min(width, 768) * 0.4);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test("mobile bottom bar opens the projects palette", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto("/");

    await expect(page.getByLabel("Collapse sidebar")).toBeHidden();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page.getByPlaceholder("Search projects...")).toBeVisible();
  });
});
