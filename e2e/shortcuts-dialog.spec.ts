import { expect, test, type Page } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });

/** Presses `key` until the sheet opens; the listener attaches on hydration. */
const openWith = async (page: Page, key: string) => {
  await expect(async () => {
    await page.keyboard.press(key);
    await expect(sheet(page)).toBeVisible({ timeout: 1_000 });
  }).toPass();
};

test.describe("keyboard shortcut sheet", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/");
  });

  test("? opens the sheet on the dashboard and Esc closes it", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    // Clicking the heading moves focus off the composer, which autofocuses.
    await page.getByRole("heading", { name: "What will you build?" }).click();

    await openWith(page, "?");
    await expect(sheet(page).getByText("New project")).toBeVisible();
    await expect(sheet(page).getByText("Quick edit the selection")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("? typed into a text field does not open the sheet", async ({ page }) => {
    const composer = page.getByRole("main").getByRole("textbox", {
      name: "Describe what you want to build",
    });
    await composer.click();
    await composer.press("?");

    await expect(composer).toHaveValue("?");
    await expect(sheet(page)).toBeHidden();
  });

  test("the command palette has a Keyboard shortcuts item", async ({ page }) => {
    const palette = page.getByRole("dialog", { name: "Search Projects" });
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette).toBeVisible({ timeout: 1_000 });
    }).toPass();

    await palette.getByRole("option", { name: "Keyboard shortcuts" }).click();
    await expect(palette).toBeHidden();
    await expect(sheet(page)).toBeVisible();
  });

  test("Ctrl+/ opens the sheet in the IDE", async ({ page }) => {
    test.setTimeout(120_000);
    const projectLink = page.locator('a[href^="/projects/"]').first();
    // The project list streams in from Convex after the page renders.
    await projectLink.waitFor({ timeout: 30_000 }).catch(() => {});
    test.skip(!(await projectLink.count()), "the e2e user has no projects");
    const href = await projectLink.getAttribute("href");

    await page.goto(href!, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "Code" })).toBeVisible({ timeout: 60_000 });

    await openWith(page, "Control+/");
    await expect(sheet(page).getByText("Accept AI suggestion")).toBeVisible();
  });
});
