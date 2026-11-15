import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { SETTINGS_NAV } from "../src/features/settings/nav";
import { collectConsoleErrors } from "./console-errors";
import { listVisibleProviders } from "../src/features/integrations/catalog";

const horizontalOverflow = () =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth;

test.describe("settings", () => {
  test("redirects a signed-out visit to the sign-in page", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    for (const path of ["/settings", ...SETTINGS_NAV.map(({ href }) => href)]) {
      await page.goto(path);

      await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);
    }
    expect(errors).toEqual([]);
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
      // Settings is the only account entry; Clerk's modal duplicate is hidden.
      await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Manage account" })).toBeHidden();
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

    for (const width of [375, 1440]) {
      test(`account shows one nav level and no Billing at ${width}px (#144)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await signIn(page);
        await page.goto("/settings/account");
        await expect(page.locator(".cl-userProfile-root")).toBeVisible();

        // Clerk's own navbar (desktop sidebar and mobile menu row) is hidden.
        await expect(page.locator(".cl-navbar")).toBeHidden();
        await expect(page.locator(".cl-navbarMobileMenuRow")).toBeHidden();

        const tabs = page.getByRole("navigation", { name: "Account" });
        await tabs.getByRole("link", { name: "Security" }).click();
        await expect(page).toHaveURL(/\/settings\/account\/security$/);
        await expect(tabs.locator('[aria-current="page"]')).toHaveText("Security");
        await expect(page.locator(".cl-profileSection__activeDevices")).toBeVisible();

        // Clerk's Billing page is not served by URL either.
        await page.goto("/settings/account/billing");
        await expect(page.getByText("Page not found")).toBeVisible();
        await expect(page.locator(".cl-userProfile-root")).toHaveCount(0);
      });
    }

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
            path: "/settings/skills",
            content: page.getByRole("heading", { level: 1, name: "Skills" }),
          },
          {
            path: "/settings/usage",
            // The month bar is there before the first metered run too (#526).
            content: page.getByRole("progressbar", { name: "This month: credits left" }),
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
          // Sidebar on desktop, tab-style links below `lg`: either way page
          // links marking the current one, not tabs (#327).
          const nav = page.getByRole("navigation", { name: "Settings" });
          await expect(nav).toBeVisible();
          await expect(nav.locator('[aria-current="page"]')).toHaveAttribute("href", path);
          // The row scrolls at 375px; the current tab must not be clipped (#218).
          await expect(nav.locator('[aria-current="page"]')).toBeInViewport({ ratio: 1 });
          await expect(nav.locator("[aria-controls], [role='tab']")).toHaveCount(0);
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

    test("integrations can be searched and filtered with the keyboard", async ({ page }) => {
      await signIn(page);
      await page.goto("/settings/integrations");
      const catalog = page.getByRole("region", { name: "Browse integrations" });
      const providers = catalog.getByRole("list", { name: "Integration providers" });
      await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
      const search = catalog.getByRole("searchbox", { name: "Search integrations" });
      await search.fill("STACK TRACES");
      await expect(providers.getByRole("listitem")).toHaveCount(1);
      await expect(providers.getByRole("button", { name: /Sentry/ })).toBeVisible();

      const database = catalog.getByRole("button", { name: "Database", exact: true });
      await database.focus();
      await page.keyboard.press("Space");
      await expect(database).toHaveAttribute("aria-pressed", "true");
      await expect(catalog.getByText("No integrations match your filters.")).toBeVisible();
      await catalog.getByRole("button", { name: "Clear filters" }).focus();
      await page.keyboard.press("Enter");
      await expect(search).toHaveValue("");
      await expect(catalog.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
    });
  });
});
