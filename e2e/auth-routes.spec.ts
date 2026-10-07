import { expect, test } from "@playwright/test";

import {
  addTestingToken,
  E2E_EMAIL,
  ensureTestUser,
  hasClerkCredentials,
} from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

// Any id works: signed-out visitors are redirected before the project is
// looked up.
const PROJECT_PATH = "/projects/k57abc123def456ghi789jkl0mn1pqr2";

/** Resolves `var(--brand)` to the computed `rgb(...)` the browser paints. */
const brandColor = () => {
  const probe = document.createElement("div");
  probe.style.color = "var(--brand)";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};

test.describe("auth routes", () => {
  for (const viewport of VIEWPORTS) {
    for (const colorScheme of ["dark", "light"] as const) {
      test(`redirects a signed-out project visit to the branded sign-in page on ${viewport.name} (${viewport.width}px, ${colorScheme})`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(
          (theme) => localStorage.setItem("theme", theme),
          colorScheme,
        );
        const errors = collectConsoleErrors(page);

        await page.goto(PROJECT_PATH);

        await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);
        expect(new URL(page.url()).searchParams.get("redirect_url")).toContain(
          PROJECT_PATH,
        );

        const primary = page.locator(".cl-formButtonPrimary");
        await expect(primary).toBeVisible();
        await expect(primary).toHaveCSS(
          "background-color",
          await page.evaluate(brandColor),
        );

        expect(errors).toEqual([]);
      });
    }
  }

  test("landing links open the sign-in and sign-up pages", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/");
    await page.getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.locator(".cl-signIn-root")).toBeVisible();

    await page.goto("/");
    await page.getByRole("link", { name: "Sign Up" }).click();
    await expect(page).toHaveURL(/\/sign-up$/);
    await expect(page.locator(".cl-signUp-root")).toBeVisible();
  });

  test("API routes answer signed-out callers with 401 JSON", async ({ request }) => {
    const response = await request.post("/api/messages", { data: {} });

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("returns to the original page after signing in", async ({ page }) => {
    test.skip(
      !hasClerkCredentials(),
      "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );

    await ensureTestUser();
    await addTestingToken(page);

    await page.goto(PROJECT_PATH);
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);

    // `+clerk_test` emails accept the fixed code 424242 on development instances.
    await page.getByLabel("Email address").fill(E2E_EMAIL);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    await page.keyboard.type("424242");

    await expect(page).toHaveURL(PROJECT_PATH);
  });
});
