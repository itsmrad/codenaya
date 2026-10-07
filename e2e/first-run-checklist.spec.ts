import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/** Signs in and opens the dashboard with any earlier dismissal cleared. */
const openDashboard = async (page: Page) => {
  await signIn(page);
  await page.goto("/");
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("codenaya:firstRunDismissed:")) localStorage.removeItem(key);
    }
  });
  await page.reload();
  return page.getByRole("region", { name: "Get started with Codenaya" });
};

test.describe("first-run checklist", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("tracks the first project and stays dismissed", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const checklist = await openDashboard(page);
    await expect(checklist).toBeVisible();

    // The e2e user has no GitHub account linked, so the card never completes.
    await expect(
      checklist.getByRole("listitem").filter({ hasText: "Connect GitHub" }),
    ).toHaveAttribute("data-done", "false");

    const firstStep = checklist.getByRole("listitem").filter({ hasText: "Create your first app" });
    const client = await userConvexClient(page);
    if ((await client.query(api.projects.get, {})).length === 0) {
      await expect(firstStep).toHaveAttribute("data-done", "false");
      const id = await client.mutation(api.projects.create, { name: "e2e first-run" });
      await expect(firstStep).toHaveAttribute("data-done", "true");
      await client.mutation(api.projects.remove, { id });
    } else {
      await expect(firstStep).toHaveAttribute("data-done", "true");
    }

    await checklist.getByRole("button", { name: "Dismiss getting started checklist" }).click();
    await expect(checklist).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { name: "What will you build?" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Your projects" })).toBeVisible();
    await expect(checklist).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("fits a 375px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const checklist = await openDashboard(page);
    await expect(checklist).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
});
