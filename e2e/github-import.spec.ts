import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

test.describe("GitHub import", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  test("asks to connect GitHub when the account is not linked", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    // The e2e user is created with an email only, so no GitHub account is linked.
    await signIn(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Import from GitHub/ }).first().click();

    const dialog = page.getByRole("dialog", { name: "Import from GitHub" });
    await dialog.getByLabel("Repository URL").fill("https://github.com/vercel/next.js");
    await dialog.getByRole("button", { name: "Import" }).click();

    await expect(dialog.getByText("GitHub account not connected")).toBeVisible();
    await dialog.getByRole("link", { name: "Connect GitHub" }).click();
    await expect(page).toHaveURL(/\/settings\/account$/);

    // The route answers 400 GITHUB_NOT_LINKED, which the browser logs as a failed load.
    expect(errors.filter((error) => !error.includes("status of 400"))).toEqual([]);
  });
});
