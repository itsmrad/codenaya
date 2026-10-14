import { expect, test, type Page } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-terminal";
const STORAGE_KEY = "codenaya:preview-terminal";

/** Answers the sandbox start with a few log lines and a ready preview, no E2B needed. */
const stubRunningSandbox = (page: Page) =>
  Promise.all([
    page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "status", status: "installing" },
          { type: "output", data: "$ npm install\r\nadded 42 packages\r\n" },
          { type: "output", data: "\x1b[32m  VITE v5.4.0\x1b[39m  ready in 312 ms\r\n" },
          { type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" },
        ]
          .map((event) => `${JSON.stringify(event)}\n`)
          .join(""),
      }),
    ),
    // File sync and teardown of the stubbed sandbox.
    page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} })),
  ]);

test.describe("preview terminal", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("starts collapsed behind a status strip and remembers the toggle", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await stubRunningSandbox(page);

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

    const strip = page.getByRole("button", { name: "Show logs" });
    const terminal = page.locator(".xterm");
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => localStorage.setItem("theme", value), theme);
      for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/projects/${projectId}?view=preview`);
        await expect(page.locator('iframe[title="Preview"]')).toBeVisible({ timeout: 60_000 });
        await expect(strip).toBeVisible();
        await expect(strip).toContainText("Running");
        await expect(strip).toContainText("VITE v5.4.0  ready in 312 ms");
        await expect(terminal).toHaveCount(0);
      }
    }

    const toggle = page.getByRole("button", { name: "Toggle terminal" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await strip.focus();
    await page.keyboard.press("Enter");
    await expect(terminal).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(terminal).toBeVisible({ timeout: 60_000 });
    await expect(strip).toHaveCount(0);

    await page.getByRole("button", { name: "Hide logs" }).click();
    await expect(strip).toBeVisible();
    await page.reload();
    await expect(page.locator('iframe[title="Preview"]')).toBeVisible({ timeout: 60_000 });
    await expect(strip).toBeVisible();
    await expect(terminal).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("opens the terminal on a start error without saving it as the choice", async ({ page }) => {
    test.setTimeout(120_000);
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({ status: 503, json: { error: "Sandbox stubbed for e2e.", code: "transient" } }),
    );

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.evaluate((key) => localStorage.setItem(key, "closed"), STORAGE_KEY);

    await page.goto(`/projects/${projectId}?view=preview`);
    await expect(page.getByText("Sandbox stubbed for e2e.")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".xterm")).toBeVisible();

    await page.getByRole("button", { name: "Hide logs" }).click();
    await expect(page.getByRole("button", { name: "Show logs" })).toContainText("Error");
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("closed");
  });
});
