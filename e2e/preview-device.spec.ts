import { expect, test } from "@playwright/test";

import { collectConsoleErrors } from "./console-errors";

/**
 * The preview lives behind Clerk auth and needs a running project, so this
 * spec only runs when given an authenticated session:
 * - E2E_STORAGE_STATE: path to a Playwright storage state for a signed-in user
 * - E2E_PREVIEW_PATH: a project page path, e.g. /projects/<id>
 */
const storageState = process.env.E2E_STORAGE_STATE;
const previewPath = process.env.E2E_PREVIEW_PATH;

test.describe("preview device toggle", () => {
  test.skip(!storageState || !previewPath, "requires E2E_STORAGE_STATE and E2E_PREVIEW_PATH");
  test.use({ storageState });

  test("constrains the preview iframe width per device", async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectConsoleErrors(page);

    await page.goto(previewPath!);
    const frame = page.getByTitle("Preview");
    await expect(frame).toBeVisible({ timeout: 180_000 });
    const panel = await frame.locator("..").boundingBox();

    const mobile = page.getByRole("button", { name: "Mobile (375px)" });
    await mobile.click();
    await expect(mobile).toHaveAttribute("aria-pressed", "true");
    expect(Math.round((await frame.boundingBox())!.width)).toBe(375);

    await page.getByRole("button", { name: "Desktop" }).click();
    expect((await frame.boundingBox())!.width).toBeCloseTo(panel!.width, 0);

    expect(errors).toEqual([]);
  });
});
