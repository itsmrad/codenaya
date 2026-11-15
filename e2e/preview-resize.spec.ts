import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

test.describe("resizing the window keeps the running preview (#777)", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("desktop <-> tablet <-> phone resizes reuse the iframe and boot no new sandbox", async ({ page }) => {
    test.setTimeout(150_000);
    const errors = collectConsoleErrors(page);
    // Stubbed sandbox, so no real E2B: counts the boot requests.
    let boots = 0;
    await page.route("**/api/sandbox", (route) => {
      boots += 1;
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
      });
    });
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const projectId = await seedPreviewProject(page, "e2e-preview-resize");
    await page.goto(`/projects/${projectId}?view=preview`);

    const iframe = page.locator('iframe[title="Preview"]');
    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    await expect(iframe).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => boots).toBe(1);
    // A remounted iframe loses this mark.
    await iframe.evaluate((el) => el.setAttribute("data-e2e-mark", "kept"));

    // Across the compact (1024) and phone (768) breakpoints, both ways.
    for (const [width, height] of [[768, 1024], [390, 844], [768, 1024], [1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await expect(iframe).toBeVisible();
      await expect(page.locator('iframe[title="Preview"][data-e2e-mark="kept"]')).toHaveCount(1);
      // One chat at every width: no second sidebar left mounted behind the pane.
      await expect(composer).toHaveCount(1);
    }
    await page.waitForTimeout(3_000); // a late reboot would show up here
    expect(boots).toBe(1);

    // Back on a phone the chat tab still works.
    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(composer).toBeVisible();
    await composer.fill("still usable");
    await expect(composer).toHaveValue("still usable");
    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(page.locator('iframe[title="Preview"][data-e2e-mark="kept"]')).toBeVisible();
    expect(boots).toBe(1);

    expect(errors).toEqual([]);
  });
});
