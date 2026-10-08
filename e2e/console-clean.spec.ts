import { expect, test, type Page } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { SETTINGS_NAV } from "../src/features/settings/nav";

const PUBLIC_PATHS = [
  "/",
  "/sign-in",
  "/docs",
  "/pricing",
  "/showcase",
  "/privacy",
  "/terms",
];

/**
 * Visits each path at 1440px and returns the console errors it logged, keyed
 * by path, so a failure names the page.
 */
const sweep = async (page: Page, paths: string[]) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = collectConsoleErrors(page);
  const found: Record<string, string[]> = {};
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    if (errors.length) found[path] = errors.splice(0);
  }
  return found;
};

test.describe("console", () => {
  test("public pages log no console errors", async ({ page }) => {
    test.setTimeout(180_000);
    expect(await sweep(page, PUBLIC_PATHS)).toEqual({});
  });

  test.describe("signed in", () => {
    test.skip(
      !hasClerkCredentials() || !process.env.E2E_PROJECT_ID,
      "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID",
    );

    test("dashboard, IDE and settings log no console errors", async ({ page }) => {
      test.setTimeout(240_000);
      await signIn(page);

      const paths = [
        "/",
        `/projects/${process.env.E2E_PROJECT_ID}`,
        ...SETTINGS_NAV.map(({ href }) => href),
      ];
      expect(await sweep(page, paths)).toEqual({});
    });
  });
});
