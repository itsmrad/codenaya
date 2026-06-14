import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { renderHarness, EXPLORER_STATES } from "./harness/render-harness";

/**
 * Visual regression suite for the file explorer.
 *
 * Each state defined in EXPLORER_STATES (empty, loading, with files, deep
 * nesting, focused) is rendered into a static harness and screenshotted. The
 * baseline images live in tests/visual/file-explorer.spec.ts-snapshots/ and are
 * compared on every run. Update them intentionally with:
 *   npm run test:visual:update
 */

let harnessUrl: string;

test.beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), "explorer-harness-"));
	const file = join(dir, "harness.html");
	writeFileSync(file, renderHarness(), "utf8");
	harnessUrl = pathToFileURL(file).href;
});

test.describe("file explorer visual states", () => {
	for (const state of EXPLORER_STATES) {
		test(`renders ${state.id}`, async ({ page }) => {
			await page.goto(harnessUrl);

			const card = page.locator(`[data-state-id="${state.id}"]`);
			await expect(card).toBeVisible();

			// Wait for fonts so text metrics are stable across runs.
			await page.evaluate(() => document.fonts.ready);

			await expect(card).toHaveScreenshot(`file-explorer-${state.id}.png`);
		});
	}
});
