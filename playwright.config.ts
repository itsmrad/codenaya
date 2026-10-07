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
  // Each worker drives a browser against one shared `next dev`; more than two
  // starve the dev server and tests flake on slow compiles.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // `next dev` compiles each route on its first visit, which takes well over
  // Playwright's 5s/30s defaults on a loaded machine.
  timeout: 60_000,
  expect: { timeout: 15_000 },
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
