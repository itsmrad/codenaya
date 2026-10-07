import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";

test.describe("IDE top bar", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  for (const width of [768, 1440]) {
    test(`tabs don't overlap the project name at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      await page.goto("/");
      const projectLink = page.locator('a[href^="/projects/"]').first();
      // The project list streams in from Convex after the page renders.
      await projectLink.waitFor({ timeout: 30_000 }).catch(() => {});
      test.skip(!(await projectLink.count()), "the e2e user has no projects");
      const href = await projectLink.getAttribute("href");

      await page.goto(href!, { waitUntil: "domcontentloaded" });
      const codeTab = page.getByRole("tab", { name: "Code" });
      await expect(codeTab).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Integrations" })).toBeVisible();

      const nav = page.locator("nav").filter({ has: codeTab });
      const projectName = nav.locator("button").first();
      const nameBox = (await projectName.boundingBox())!;
      const tabBox = (await codeTab.boundingBox())!;
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(tabBox.x);
    });
  }
});
