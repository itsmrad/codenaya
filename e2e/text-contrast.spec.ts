import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";

/** Selectors of text under WCAG AA contrast, as axe reports it (#216). */
const contrastViolations = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    // Clerk's "Secured by" branding sits over its dev-instance-only orange
    // "Development mode" badge, which production never renders.
    .exclude(".cl-footerItem")
    .analyze();
  return violations.flatMap(({ nodes }) => nodes.map(({ target }) => target.join(" ")));
};

/** Scrolls through the page so every in-view entrance animation has played. */
const revealAll = async (page: Page) => {
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }
  // The slowest entrance (staggered steps) settles within about a second.
  await page.waitForTimeout(1500);
};

for (const theme of ["dark", "light"] as const) {
  test.describe(`text contrast, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      // Public pages keep their own theme (landing-theme.tsx), apart from the app's.
      await page.addInitScript((value) => {
        localStorage.setItem("theme", value);
        localStorage.setItem("codenaya-landing-theme", value);
      }, theme);
    });

    test("landing page", async ({ page }) => {
      await page.goto("/");
      await revealAll(page);

      expect(await contrastViolations(page)).toEqual([]);
    });

    test("sign-in page", async ({ page }) => {
      await page.goto("/sign-in");
      await expect(page.locator(".cl-footerActionLink")).toBeVisible();

      expect(await contrastViolations(page)).toEqual([]);
    });

    test("account settings (Clerk profile)", async ({ page }) => {
      test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
      await signIn(page);
      await page.goto("/settings/account");
      await expect(page.locator(".cl-profileSectionPrimaryButton").first()).toBeVisible();

      expect(await contrastViolations(page)).toEqual([]);
    });

    test("showcase detail page", async ({ page }) => {
      const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
      const [project] = await client.query(api.showcase.getTrending, { limit: 1 });
      test.skip(!project, "no published showcase projects to show");

      await page.goto(`/showcase/${project._id}`);
      await expect(page.getByRole("button", { name: "Remix" })).toBeVisible();
      await revealAll(page);

      expect(await contrastViolations(page)).toEqual([]);
    });
  });
}
