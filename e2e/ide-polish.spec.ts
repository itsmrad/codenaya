import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e ide polish";

/** The aborted request below is the scenario, not a bug. */
const ABORTED_SANDBOX = /net::ERR_FAILED/;

/** Same project as `seedPreviewProject`, with every file removed. */
const emptyProject = async (page: Page) => {
  const projectId = await seedPreviewProject(page, PROJECT_NAME);
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await system.mutation(api.system.cleanup, {
    internalKey: process.env.CODENAYA_CONVEX_INTERNAL_KEY!,
    projectId,
  });
  return projectId;
};

const openProject = async (page: Page, projectId: string, width: number) => {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
  await page.goto(`/projects/${projectId}?engine=webcontainer`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });
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
      await page.getByRole("button", { name: "Export" }).click();
      const box = (await page.locator("[data-slot=popover-content]").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
      await page.keyboard.press("Escape");
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
