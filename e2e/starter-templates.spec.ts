import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PENDING_TEMPLATE_KEY = "codenaya:pendingTemplate";
const TEMPLATE_CARD = /^Use the .+ template$/;

// The template's own files in the explorer, which only shows on the Code view. Scoped to
// the explorer so the run card's trigger and file chips in the chat can't satisfy it.
const openExplorer = async (page: Page) => {
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  return page.getByTestId("file-explorer");
};

const openTemplatesTab = async (page: Page) => {
  await page.getByRole("heading", { name: "What will you build?" }).waitFor();
  const tab = page.getByRole("tab", { name: "Templates" });
  if (await tab.isVisible()) await tab.click();
};

test.describe("starter templates on /showcase (signed out)", () => {
  for (const width of [375, 768, 1440]) {
    test(`shows the six templates without page overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors = collectConsoleErrors(page);
      await page.goto("/showcase");

      const section = page.getByRole("region", { name: "Templates" });
      await expect(section.getByRole("button", { name: TEMPLATE_CARD })).toHaveCount(6);
      await expect(section.getByRole("button", { name: "Use the Landing page template" })).toBeEnabled();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test("picking a template sends the visitor to sign up and keeps the pick", async ({ page }) => {
    await page.goto("/showcase");

    await page.getByRole("button", { name: "Use the Blog template" }).click();

    await expect(page).toHaveURL(/\/sign-up/);
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).value, PENDING_TEMPLATE_KEY)).toBe(
      "blog",
    );
  });
});

test.describe("starter templates on the dashboard", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("an instant template opens in the IDE with its files and no run", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/");
    const errors = collectConsoleErrors(page);
    // Users with projects find the templates in a tab; first-run users see them inline.
    await openTemplatesTab(page);

    const section = page.getByRole("region", { name: "Start from a template" });
    await expect(section.getByRole("button", { name: TEMPLATE_CARD })).toHaveCount(6);

    await section.getByRole("button", { name: "Use the Landing page template" }).click();

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split("/").pop() as Id<"projects">;
    try {
      const explorer = await openExplorer(page);
      await expect(explorer.getByRole("button", { name: "package.json", exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(explorer.getByRole("button", { name: "src", exact: true })).toBeVisible();
      // An instant template opens as a finished app: no run, so the chat stays
      // empty and offers "Make it mine" (#362).
      const card = page.getByRole("region", { name: "Make it mine" });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByLabel("App name").fill("Acme");
      await card.getByRole("button", { name: "Teal" }).click();
      await card.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByText("Applied to your app")).toBeVisible();
      await expect(card).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      // Don't pile up template projects across runs.
      await (await userConvexClient(page)).mutation(api.projects.remove, { id: projectId });
    }
  });

  test("a template picked before signing up is created on the dashboard", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.evaluate(
      ([key, id]) => localStorage.setItem(key, id),
      [PENDING_TEMPLATE_KEY, "portfolio"],
    );

    await page.goto("/");

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split("/").pop() as Id<"projects">;
    try {
      const explorer = await openExplorer(page);
      await expect(explorer.getByRole("button", { name: "package.json", exact: true })).toBeVisible({
        timeout: 30_000,
      });
      expect(await page.evaluate((key) => localStorage.getItem(key), PENDING_TEMPLATE_KEY)).toBeNull();
    } finally {
      await (await userConvexClient(page)).mutation(api.projects.remove, { id: projectId });
    }
  });
});
