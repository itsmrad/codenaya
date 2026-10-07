import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e configuration.
 *
 * `@playwright/test` is pinned to the version whose Chromium build is already
 * cached in `~/.cache/ms-playwright`, so local runs need no browser download.
 * `webServer` starts `next dev` on E2E_PORT (default 3113) and reuses a server
 * that is already listening there. `globalSetup` signs this run's Clerk pool
 * user in once (see `e2e/clerk-auth.ts`).
 */
const port = Number(process.env.E2E_PORT ?? 3113);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? "github"
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npx next dev -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
