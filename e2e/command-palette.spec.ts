import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

/** Presses `key` until the palette opens; the listener attaches on hydration. */
const openWith = async (page: Page, key: string) => {
  await expect(async () => {
    await page.keyboard.press(key);
    await expect(palette(page)).toBeVisible({ timeout: 1_000 });
  }).toPass();
};

const selectedOption = (page: Page) =>
  palette(page).locator('[role="option"][aria-selected="true"]');

/** The e2e user's first project, from the dashboard list. */
const openFirstProject = async (page: Page) => {
  await page.goto("/");
  const projectLink = page.locator('a[href^="/projects/"]').first();
  // The project list streams in from Convex after the page renders.
  await projectLink.waitFor({ timeout: 30_000 }).catch(() => {});
  test.skip(!(await projectLink.count()), "the e2e user has no projects");
  await page.goto((await projectLink.getAttribute("href"))!, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "Code" })).toBeVisible({ timeout: 60_000 });
};

test.describe("command palette", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
  });

  test("dashboard: labelled, arrow keys, focus stays inside, Esc closes", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");
    // Clicking the heading moves focus off the composer, which autofocuses.
    const heading = page.getByRole("heading", { name: "What will you build?" });
    await heading.click();

    await openWith(page, "ControlOrMeta+k");
    const dialog = palette(page);
    await expect(dialog).toHaveAccessibleDescription("Search for a project, a page or an action");
    await expect(dialog.getByRole("combobox")).toBeFocused();
    for (const name of ["New project", "Import from GitHub", "AI providers settings", "Docs"]) {
      await expect(dialog.getByRole("option", { name })).toBeVisible();
    }
    await expect(dialog.getByRole("option", { name: /Switch to (light|dark) theme/ })).toBeVisible();
    // IDE actions only show in the IDE.
    await expect(dialog.getByRole("option", { name: "Show preview" })).toHaveCount(0);

    const first = await selectedOption(page).textContent();
    await page.keyboard.press("ArrowDown");
    await expect(selectedOption(page)).not.toHaveText(first!);
    await page.keyboard.press("ArrowUp");
    await expect(selectedOption(page)).toHaveText(first!);

    // Radix traps focus: tabbing never leaves the dialog.
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }

    const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(violations.map(({ id }) => id)).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("the Find a project button opens it, and typing filters to a page", async ({ page }) => {
    await page.goto("/");
    await expect(async () => {
      await page.getByRole("button", { name: /Find a project/ }).click();
      await expect(palette(page)).toBeVisible({ timeout: 1_000 });
    }).toPass();

    await palette(page).getByRole("combobox").fill("docs");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/docs$/);
    await expect(palette(page)).toBeHidden();
  });

  test("settings: Cmd/Ctrl+Shift+P opens it and Keyboard shortcuts lists the IDE bindings", async ({ page }) => {
    await page.goto("/settings/appearance");
    await expect(page.getByRole("heading", { name: "Appearance" }).first()).toBeVisible({ timeout: 30_000 });

    await openWith(page, "ControlOrMeta+Shift+P");
    await palette(page).getByRole("option", { name: "Keyboard shortcuts" }).click();
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    const ide = sheet.getByRole("region", { name: "IDE" });
    await expect(ide.getByText("Command palette, outside the editor")).toBeVisible();
    await expect(ide.getByText("Command palette, in the editor too")).toBeVisible();
  });

  test("the theme item switches the theme", async ({ page }) => {
    await page.goto("/");
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
    await page.getByRole("heading", { name: "What will you build?" }).click();
    const before = await isDark();

    await openWith(page, "ControlOrMeta+k");
    await palette(page).getByRole("option", { name: /Switch to (light|dark) theme/ }).click();
    await expect.poll(isDark).toBe(!before);
  });

  test("IDE: Cmd/Ctrl+K outside the editor opens it and Show preview switches the view", async ({ page }) => {
    test.setTimeout(120_000);
    // Opening the preview boots a sandbox; refuse it so the run costs nothing.
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({ status: 503, json: { error: "stubbed", code: "config" } }),
    );
    await openFirstProject(page);
    await page.getByRole("tab", { name: "Code" }).click();

    await openWith(page, "ControlOrMeta+k");
    const dialog = palette(page);
    for (const name of ["Show code", "Toggle chat panel", "New conversation", "Version history", "Export ZIP", "Environment variables"]) {
      await expect(dialog.getByRole("option", { name })).toBeVisible();
    }
    await dialog.getByRole("option", { name: "Show preview" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");

    // Same handler as the toolbar's key button, even with the preview never opened before.
    await openWith(page, "ControlOrMeta+k");
    await palette(page).getByRole("option", { name: "Environment variables" }).click();
    await expect(page.getByRole("dialog", { name: "Environment Variables" })).toBeVisible();
    await page.keyboard.press("Escape");

    await openWith(page, "ControlOrMeta+k");
    await palette(page).getByRole("option", { name: "Toggle chat panel" }).click();
    await expect(page.getByRole("button", { name: "New conversation" })).toBeHidden();
    await openWith(page, "ControlOrMeta+k");
    await palette(page).getByRole("option", { name: "Toggle chat panel" }).click();
    await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
  });

  test("IDE editor: Cmd/Ctrl+K stays quick edit, Cmd/Ctrl+Shift+P opens the palette", async ({ page }) => {
    test.setTimeout(120_000);
    // quick-edit.spec.ts seeds this project; reading it here writes nothing.
    await page.goto("/");
    const user = await userConvexClient(page);
    const project = (await user.query(api.projects.get, {})).find(({ name }) => name === "e2e-quick-edit");
    test.skip(!project, "needs the e2e-quick-edit project (run quick-edit.spec.ts once)");

    await page.goto(`/projects/${project!._id}`);
    await page.getByRole("button", { name: "math.ts", exact: true }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("return");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder("Edit selected code")).toBeVisible();
    await expect(palette(page)).toBeHidden();

    await page.keyboard.press("Escape");
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(palette(page)).toBeVisible();
  });
});
