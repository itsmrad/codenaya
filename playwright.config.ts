import { defineConfig, devices } from "@playwright/test";

/**
 * Visual regression config for the file explorer.
 *
 * Runs entirely offline against a static harness (tests/visual/harness) so it
 * needs no Clerk auth, no Convex backend and no network — safe to run on every
 * commit in CI. Screenshots are pinned to a single Chromium device + a fixed
 * viewport so baselines are deterministic across machines.
 */
export default defineConfig({
	testDir: "./tests/visual",
	// Fail the build if someone leaves a test.only in the suite.
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
	// Tighten the pixel diff tolerance; small anti-aliasing noise is allowed but
	// real layout/colour regressions fail.
	expect: {
		toHaveScreenshot: {
			maxDiffPixelRatio: 0.01,
			animations: "disabled",
			caret: "hide",
		},
	},
	use: {
		...devices["Desktop Chrome"],
		viewport: { width: 1280, height: 720 },
		deviceScaleFactor: 1,
		colorScheme: "dark",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
