import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

const LINKS = ["Showcase", "Pricing", "Docs"] as const;

// Each public route and the header link that should be marked current on it.
const ROUTES = [
  { path: "/", current: null },
  { path: "/pricing", current: "Pricing" },
  { path: "/docs", current: "Docs" },
  { path: "/showcase", current: "Showcase" },
  { path: "/showcase/not-a-real-id", current: "Showcase" },
  { path: "/terms", current: null },
  { path: "/privacy", current: null },
  { path: "/sign-in", current: null },
  { path: "/sign-up", current: null },
  { path: "/this-page-does-not-exist", current: null },
] as const;

test.describe("marketing navbar (signed out)", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ["dark", "light"] as const) {
      test(`every public route shares the header at ${viewport.width}px (${theme})`, async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize(viewport);
        await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
        const errors = collectConsoleErrors(page);
        const mobile = viewport.width < 768;
        let firstBar: { x: number; width: number } | undefined;
        let firstBrandX: number | undefined;

        for (const { path, current } of ROUTES) {
          await page.goto(path);
          const header = page.locator("header").first();
          await expect(header.getByRole("link", { name: "Codenaya" })).toBeVisible();
          const bar = await header.getByRole("navigation", { name: "Main" }).boundingBox();
          expect(bar?.height, `${path} bar height`).toBeCloseTo(56, 0);
          expect(bar).not.toBeNull();
          firstBar ??= bar!;
          expect(bar!.x, `${path} bar inset`).toBeCloseTo(firstBar.x, 0);
          expect(bar!.width, `${path} bar width`).toBeCloseTo(firstBar.width, 0);
          const brand = await header.getByRole("link", { name: "Codenaya" }).boundingBox();
          firstBrandX ??= brand!.x;
          expect(brand!.x, `${path} logo position`).toBeCloseTo(firstBrandX, 0);

          const content = path === "/" ? page.locator("main h1").first() : page.locator("main").first();
          await expect(content).toBeVisible();
          expect((await content.boundingBox())!.y, `${path} content clears the header`).toBeGreaterThanOrEqual(
            bar!.y + bar!.height,
          );

          // Below md the links live in the sheet behind the menu button.
          if (mobile) await header.getByRole("button", { name: "Toggle menu" }).click();
          const scope = mobile ? page.getByRole("dialog") : header;

          for (const name of LINKS) {
            const link = scope.getByRole("link", { name, exact: true });
            await expect(link, `${path}: ${name}`).toBeVisible();
            if (name === current) await expect(link).toHaveAttribute("aria-current", "page");
            else await expect(link).not.toHaveAttribute("aria-current");
          }
          await expect(scope.getByRole("link", { name: "Log in" })).toBeVisible();
          await expect(scope.getByRole("link", { name: "Sign Up" })).toBeVisible();

          if (mobile) await page.keyboard.press("Escape");
        }

        await page.waitForLoadState("networkidle");
        // The browser logs the 404 route's own document response as a failed load.
        expect(errors.filter((error) => !error.includes("status of 404"))).toEqual([]);
      });
    }
  }

  test("the header link moves between public pages", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/pricing");

    await page.locator("header").getByRole("link", { name: "Docs", exact: true }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(
      page.locator("header").getByRole("link", { name: "Docs", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });
});

test.describe("marketing navbar (signed in)", () => {
  test.skip(!hasClerkCredentials(), "needs Clerk credentials");

  for (const viewport of VIEWPORTS) {
    test(`public pages offer Dashboard and the user menu at ${viewport.width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await signIn(page);
      const errors = collectConsoleErrors(page);

      for (const path of ["/pricing", "/docs", "/showcase", "/terms", "/privacy", "/this-page-does-not-exist"]) {
        await page.goto(path);
        const header = page.locator("header").first();
        await expect(header.getByRole("button", { name: "Open user menu" })).toBeVisible();
        const mobile = viewport.width < 768;
        if (mobile) await header.getByRole("button", { name: "Toggle menu" }).click();
        const scope = mobile ? page.getByRole("dialog") : header;
        await expect(scope.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
        await expect(scope.getByRole("link", { name: "Dashboard" })).toBeVisible();
        await expect(scope.getByRole("link", { name: "Log in" })).toHaveCount(0);
        await expect(scope.getByRole("link", { name: "Sign Up" })).toHaveCount(0);
        if (mobile) await page.keyboard.press("Escape");
      }

      await page.locator("header").getByRole("button", { name: "Open user menu" }).click();
      await expect(page.getByRole("dialog", { name: "Account panel" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
      expect(errors.filter((error) => !error.includes("status of 404"))).toEqual([]);
    });
  }
});
