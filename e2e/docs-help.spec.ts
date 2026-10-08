import { expect, test, type Page } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

test.describe("docs page (signed out)", () => {
  test("loads with its sections and anchor links scroll to them", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    // The first visit compiles the page in dev, which can take a while.
    await page.goto("/docs", { timeout: 60_000 });

    await expect(page.getByRole("heading", { level: 1, name: "Docs" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Getting started" })).toBeVisible();
    const integrations = page.getByRole("heading", { name: "Integrations & approvals" });
    await expect(integrations).toBeAttached();

    await page
      .getByRole("navigation", { name: "On this page" })
      .getByRole("link", { name: "Integrations & approvals" })
      .click();
    await expect(page).toHaveURL(/\/docs#integrations$/);
    await expect(integrations).toBeInViewport();

    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  test("has no horizontal scroll at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/docs", { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeAttached();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal overflow in px").toBe(0);
  });
});

const helpMenu = (page: Page) => page.getByRole("menu");

/** Opens the navbar Help menu; the trigger works once the page hydrates. */
const openHelpMenu = async (page: Page) => {
  await expect(async () => {
    await page.getByRole("button", { name: "Help" }).click();
    await expect(helpMenu(page)).toBeVisible({ timeout: 1_000 });
  }).toPass();
};

test.describe("help menu (signed in)", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/");
  });

  test("links to the docs, shortcuts and bug reports", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openHelpMenu(page);

    await expect(helpMenu(page).getByRole("menuitem", { name: "Report a bug" })).toHaveAttribute(
      "href",
      /github\.com\/itsmrad\/codenaya\/issues\/new$/,
    );
    await expect(helpMenu(page).getByRole("menuitem", { name: "Docs" })).toHaveAttribute(
      "href",
      "/docs",
    );

    await helpMenu(page).getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the IDE navbar has the Help menu", async ({ page }) => {
    test.setTimeout(120_000);
    const projectLink = page.locator('a[href^="/projects/"]').first();
    // The project list streams in from Convex after the page renders.
    await projectLink.waitFor({ timeout: 30_000 }).catch(() => {});
    test.skip(!(await projectLink.count()), "the e2e user has no projects");
    const href = await projectLink.getAttribute("href");

    await page.goto(href!, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "Code" })).toBeVisible({ timeout: 60_000 });

    await openHelpMenu(page);
    await helpMenu(page).getByRole("menuitem", { name: "Docs" }).click();
    await expect(page).toHaveURL(/\/docs$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Getting started" })).toBeVisible();
  });
});
