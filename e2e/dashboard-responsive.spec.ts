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

  test("phones reach the projects palette from the hero", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Find a project" }).click();
    await expect(page.getByPlaceholder("Search projects...")).toBeVisible();
  });

  test("project search filters the grid", async ({ page }) => {
    await signIn(page);
    await page.goto("/");

    const grid = page.getByRole("region", { name: "Your projects" });
    const cards = grid.getByRole("link");
    await expect(cards.first()).toBeVisible();
    const name = (await cards.first().getByRole("paragraph").first().textContent())!;

    await grid.getByRole("searchbox", { name: "Search projects" }).fill(name);
    await expect(cards.first()).toContainText(name);
    await grid.getByRole("searchbox", { name: "Search projects" }).fill("zz-no-such-project-zz");
    await expect(grid.getByText(/No projects match/)).toBeVisible();
  });

  test("the community showcase has its own page", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await signIn(page);
    await page.goto("/showcase");

    await expect(page.getByRole("heading", { name: "Community showcase" })).toBeVisible();
    await expect(page.getByPlaceholder("Search showcase...")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
