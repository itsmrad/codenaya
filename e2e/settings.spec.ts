import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const horizontalOverflow = () =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth;

test.describe("settings", () => {
  test("redirects a signed-out visit to the sign-in page", async ({ page }) => {
    await page.goto("/settings");

    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);
  });

  test.describe("signed in", () => {
    test.skip(
      !hasClerkCredentials(),
      "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );

    test("user menu opens the themed account page", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const errors = collectConsoleErrors(page);
      await signIn(page);

      await page.locator(".cl-userButtonTrigger").click();
      await page.getByRole("button", { name: "Settings" }).click();

      await expect(page).toHaveURL(/\/settings\/account$/);
      await expect(page.locator(".cl-userProfile-root")).toBeVisible();
      // The brand theme reaches the embedded card (shadcn theme variables).
      await expect(page.locator(".cl-cardBox")).toHaveCSS(
        "font-family",
        /Inter/,
      );
      expect(errors).toEqual([]);
    });

    for (const width of [375, 768, 1440]) {
      test(`every tab is deep-linkable and fits ${width}px`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 900 });
        const errors = collectConsoleErrors(page);
        await signIn(page);

        const tabs = [
          { path: "/settings/account", content: page.locator(".cl-userProfile-root") },
          {
            path: "/settings/ai-providers",
            content: page.getByRole("heading", { level: 1, name: "AI providers" }),
          },
          {
            path: "/settings/integrations",
            content: page.getByRole("heading", { level: 1, name: "Integrations" }),
          },
          {
            path: "/settings/appearance",
            content: page.getByRole("heading", { level: 1, name: "Appearance" }),
          },
        ];
        for (const { path, content } of tabs) {
          await page.goto(path);
          await expect(content).toBeVisible();
          // Sidebar on desktop, tabs below `lg`.
          const nav =
            width >= 1024
              ? page.getByRole("navigation", { name: "Settings" })
              : page.getByRole("tablist", { name: "Settings" });
          await expect(nav).toBeVisible();
          expect(await page.evaluate(horizontalOverflow)).toBe(0);
        }

        expect(errors).toEqual([]);
      });
    }

    test("the light theme persists across reloads", async ({ page }) => {
      await signIn(page);
      await page.goto("/settings/appearance");

      await page.getByRole("radio", { name: "Light" }).click();
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

      await page.reload();
      await expect(page.getByRole("radio", { name: "Light" })).toBeChecked();
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    });
  });
});
