import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const projectId = process.env.E2E_PROJECT_ID;

test.describe("project environment variables", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  test("adds, lists and deletes a public variable", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.getByText("Preview", { exact: true }).first().click();
    await page.getByRole("button", { name: "Environment variables" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Key").fill("NEXT_PUBLIC_DEMO");
    await dialog.getByLabel("Value").fill("1");
    await dialog.getByRole("button", { name: "Save Variable" }).click();

    const key = dialog.getByText("NEXT_PUBLIC_DEMO", { exact: true });
    await expect(key).toBeVisible();

    await dialog.getByRole("button", { name: "Delete NEXT_PUBLIC_DEMO" }).click();
    await expect(key).toHaveCount(0);

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
