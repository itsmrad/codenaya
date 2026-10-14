import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-boot-steps";

/** A boot that has written the files and is installing; the stream then ends without `ready`. */
const at = Date.now();
const INSTALLING = [
  { type: "status", status: "booting" },
  { type: "phase", phase: "create", at: at - 5000 },
  { type: "output", data: "Creating E2B sandbox...\n" },
  { type: "phase", phase: "files", at: at - 2000 },
  { type: "status", status: "installing" },
  { type: "phase", phase: "install", at },
  { type: "output", data: "$ npm install\n" },
];

test.describe("preview boot steps", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("shows the boot as four steps with elapsed time and a Show logs link", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: INSTALLING.map((event) => JSON.stringify(event)).join("\n") + "\n",
      }),
    );
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.evaluate(() => localStorage.setItem("codenaya:preview-terminal", "closed"));
    await page.goto(`/projects/${projectId}?view=preview`);

    const boot = page.getByRole("status", { name: "Starting preview" });
    await expect(boot).toBeVisible({ timeout: 60_000 });
    const steps = boot.getByRole("listitem");
    await expect(steps).toHaveText([
      /Create sandbox\s*\(done\)/,
      /Write files\s*\(done\)/,
      /Install dependencies\s*\(in progress\)/,
      /Start dev server/,
    ]);
    await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");
    await expect(steps.nth(3)).toHaveAttribute("data-state", "pending");
    await expect(steps.nth(0)).toContainText("3s");
    await expect(steps.nth(1)).toContainText("2s");
    // The elapsed time ticks, and the latest log line shows under the steps.
    const elapsed = boot.getByText(/^\d+s$/).first();
    const first = await elapsed.textContent();
    await expect(elapsed).not.toHaveText(first!, { timeout: 5_000 });
    await expect(boot).toContainText("$ npm install");

    // Main keeps logs collapsed by default; opening them persists that choice.
    const terminal = page.locator(".xterm");
    await expect(terminal).toHaveCount(0);
    await boot.getByRole("button", { name: "Show logs" }).click();
    await expect(terminal).toBeVisible();
    await expect(boot.getByRole("button", { name: "Show logs" })).toBeHidden();
    await page.getByRole("button", { name: "Hide logs" }).click();
    await expect(terminal).toHaveCount(0);
    await expect(boot.getByRole("button", { name: "Show logs" })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("keeps the active step within narrow panels in both themes and hands off to the preview", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    let ready = false;
    await page.route("**/api/sandbox", (route) => route.fulfill({
      contentType: "application/x-ndjson",
      body: [...INSTALLING, ...(ready ? [
        { type: "phase", phase: "start", at: Date.now() },
        { type: "phase", phase: "ready", at: Date.now() },
        { type: "ready", sandboxId: "boot-smoke", previewUrl: "about:blank" },
      ] : [])].map((event) => JSON.stringify(event)).join("\n") + "\n",
    }));
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
    await signIn(page);
    const projectId = await seedPreviewProject(page, `${PROJECT_NAME}-responsive`);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => localStorage.setItem("codenaya:preview-terminal", "closed"));
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => localStorage.setItem("theme", value), theme);
      for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`/projects/${projectId}?view=preview`);
        const boot = page.getByRole("status", { name: "Starting preview" });
        await expect(boot.getByRole("listitem").nth(2)).toHaveAttribute("aria-current", "step");
        await expect.poll(() => boot.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(boot.getByRole("button", { name: "Show logs" })).toBeVisible();
      }
    }
    ready = true;
    await page.reload();
    await expect(page.locator('iframe[title="Preview"]')).toBeVisible();
    await expect(page.getByRole("status", { name: "Starting preview" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

});
