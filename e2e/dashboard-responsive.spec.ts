import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

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

  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1440, 900],
  ]) {
    test(`a recent project is fully visible without scrolling at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await signIn(page);
      const client = await userConvexClient(page);
      test.skip((await client.query(api.projects.get, {})).length === 0, "needs a project");
      await page.goto("/");

      const card = page.getByRole("region", { name: "Recent" }).getByRole("link").first();
      await expect(card).toBeVisible();
      // Wait for the entrance animation to settle: two reads in a row agree.
      let previous = await card.boundingBox();
      await expect
        .poll(async () => {
          const current = await card.boundingBox();
          const settled = current?.y === previous?.y;
          previous = current;
          return settled;
        })
        .toBe(true);
      const box = (await card.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    });
  }

  test("the dashboard tabs work from the keyboard and remember the last one", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await signIn(page);
    const client = await userConvexClient(page);
    test.skip((await client.query(api.projects.get, {})).length === 0, "needs a project");
    await page.goto("/");

    const projectsTab = page.getByRole("tab", { name: "Projects" });
    const templatesTab = page.getByRole("tab", { name: "Templates" });
    await expect(projectsTab).toHaveAttribute("aria-selected", "true");
    await projectsTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(templatesTab).toBeFocused();
    await expect(templatesTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "Start from a template" })).toBeVisible();

    await page.reload();
    await expect(templatesTab).toHaveAttribute("aria-selected", "true");

    // "View all" in the Recent row goes back to the projects grid.
    await page.getByRole("button", { name: "View all" }).click();
    await expect(projectsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "Your projects" })).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test("phones reach the projects palette from the hero", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Find a project" }).click();
    await expect(page.getByPlaceholder("Type a command or search...")).toBeVisible();
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
    await expect(page.getByRole("textbox", { name: "Search showcase" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
