import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";
import { cleanupProject } from "./convex-client";

const PROJECT_NAME = "e2e phone project UI";

/** The aborted request below is the scenario, not a bug. */
const ABORTED_SANDBOX = /net::ERR_FAILED/;

/** Same project as `seedPreviewProject`, with every file removed. */
const emptyProject = async (page: Page) => {
  const projectId = await seedPreviewProject(page, PROJECT_NAME);
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await cleanupProject(system, process.env.CODENAYA_CONVEX_INTERNAL_KEY!, projectId);
  return projectId;
};

const openProject = async (page: Page, projectId: string, width: number) => {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
  await page.goto(`/projects/${projectId}?engine=webcontainer`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("nav").getByRole("button", { name: PROJECT_NAME, exact: true })).toBeVisible({ timeout: 60_000 });
};

test.describe("IDE polish", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("Publish is disabled with a hint for a project with no files", async ({ page }) => {
    await signIn(page);
    const projectId = await emptyProject(page);
    await openProject(page, projectId, 1440);

    await page.getByRole("button", { name: "Publish" }).click();
    const dialog = page.getByRole("dialog", { name: "Publish to Showcase" });
    await expect(dialog.getByText("Add some files to this project before publishing it.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  test("top-bar actions match, popovers keep a gutter and the Publish footer stays visible", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await openProject(page, projectId, 1440);

    const styles = await Promise.all(
      ["Publish", "Integrations", "Skills", "Export"].map((name) =>
        page.getByRole("button", { name, exact: true }).evaluate((el) => {
          const { fontSize, fontWeight, paddingLeft, height } = getComputedStyle(el);
          return { fontSize, fontWeight, paddingLeft, height };
        }),
      ),
    );
    for (const style of styles) expect(style).toEqual(styles[0]);

    for (const width of [375, 768]) {
      await openProject(page, projectId, width);
      const more = page.getByRole("button", { name: "More actions" });
      const usesSheet = await more.isVisible();
      if (usesSheet) await more.click();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const box = (await page.locator("[data-slot=popover-content]").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
      await page.keyboard.press("Escape");
      if (usesSheet) await page.keyboard.press("Escape");
    }

    // At 375 the form is taller than the dialog; the footer must not scroll away.
    await page.getByRole("button", { name: "Publish" }).click();
    const dialog = page.getByRole("dialog", { name: "Publish to Showcase" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Publish" })).toBeInViewport();
    await page.keyboard.press("Escape");

    // The minimap would cover the code on a phone.
    await page.getByRole("tab", { name: "Code" }).click();
    await page.getByRole("button", { name: "index.html", exact: true }).click();
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.locator(".cm-minimap-gutter")).toBeHidden();

    expect(errors).toEqual([]);
  });

  test("phones show the project name and reach labeled actions from the keyboard", async ({ page }) => {
    await signIn(page);
    const projectId = await emptyProject(page);
    await openProject(page, projectId, 375);
    const name = page.locator("nav").getByRole("button", { name: PROJECT_NAME, exact: true });
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const longName = "e2e phone project with a very long name that must truncate inside the IDE top bar";
    await name.click();
    const rename = page.getByRole("textbox", { name: "Project name", exact: true });
    await rename.fill(longName);
    await rename.press("Enter");
    const longTitle = page.locator("nav").getByRole("button", { name: longName, exact: true });
    await expect(longTitle).toBeVisible();
    expect(await longTitle.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(longTitle).toHaveCSS("text-overflow", "ellipsis");
    const titleBox = (await longTitle.boundingBox())!;
    const navBox = (await page.locator("nav").boundingBox())!;
    expect(titleBox.x).toBeGreaterThanOrEqual(navBox.x);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(navBox.x + navBox.width);
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveText("Publish");
    await expect(page.getByRole("button", { name: "Version history", exact: true })).toBeHidden();

    const more = page.getByRole("button", { name: "More actions" });
    await more.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Project menu" });
    for (const label of ["Integrations", "Skills", "Export", "Version history", "Past conversations", "New conversation", "Help"]) {
      await expect(sheet.getByRole("button", { name: label, exact: true })).toHaveText(label);
    }
    await expect(sheet.getByRole("link", { name: "Account", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Integrations", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(sheet.getByRole("button", { name: "Integrations", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await sheet.getByRole("button", { name: "Version history", exact: true }).click();
    const history = page.getByRole("dialog", { name: "Version history" });
    await expect(sheet).toBeHidden();
    await expect(history).toBeVisible();
    await page.keyboard.press("Escape");
    await more.click();
    await sheet.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download ZIP", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
  });

  test("the explorer header gives the project name the full width until hovered", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);

    for (const width of [768, 1024, 1440]) {
      await openProject(page, projectId, width);
      await page.getByRole("tab", { name: "Code" }).click();
      // The collapse toggle (the navbar's rename button has the same name); its
      // actions are siblings, not children (#265).
      const header = page.getByRole("button", { name: PROJECT_NAME, exact: true, expanded: true });
      const name = header.getByText(PROJECT_NAME, { exact: true });
      await expect(name).toHaveAttribute("title", PROJECT_NAME);
      // Hidden actions take no width, so a short name is not cut off.
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

      const chevron = header.locator("svg").first();
      const before = (await chevron.boundingBox())!;
      // Not the header's centre: in the 200px explorer (768/1024) the shown actions
      // cover it, so Playwright's hover never lands on the header (#606).
      await chevron.hover();
      // The actions' wrapper carries the hover opacity, not the buttons.
      const actions = page.getByRole("button", { name: "Create file", exact: true }).locator("..");
      await expect(actions).toHaveCSS("opacity", "1");
      expect((await chevron.boundingBox())!.x).toBe(before.x);
    }

    expect(errors).toEqual([]);
  });

  test("a dropped sandbox connection reads as a sentence", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.route("**/api/sandbox", (route) => route.abort("failed"));
    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${projectId}?engine=sandbox&view=preview`);

    const alert = page.getByRole("alert").filter({ hasText: "Preview failed to start" });
    await expect(alert).toContainText(
      "Couldn't reach the preview sandbox. Check your connection and retry.",
      { timeout: 60_000 },
    );
    expect(errors.filter((error) => !ABORTED_SANDBOX.test(error))).toEqual([]);
  });
});
