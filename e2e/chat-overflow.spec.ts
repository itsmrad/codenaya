import { expect, test } from "@playwright/test";

import {
  chatOverflow,
  chatScrollsHorizontally,
  hasInternalKey,
  seedOverflowConversation,
  setChatPanelWidth,
} from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

// Regression for #132: a pasted log or a long unbroken token pushed the user
// bubble past the panel's left edge, and file chips wrapped under the icons.
test.describe("chat panel overflow", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CODENAYA_CONVEX_INTERNAL_KEY and NEXT_PUBLIC_CONVEX_URL",
  );

  test("long messages and many file reads stay inside the panel", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    // Its own project: in the shared E2E_PROJECT_ID, another spec's newer
    // conversation can become the active one mid-test.
    const projectId = await seedPreviewProject(page, "e2e chat overflow");
    const stopRun = await seedOverflowConversation(page, projectId);
    try {
      await page.goto(`/projects/${projectId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      const liveRun = page.locator('[data-run-status="running"]');
      await expect(liveRun.getByText("Read 17 files")).toBeVisible({ timeout: 60_000 });

      // Where the summary truncates, the failed step's count stays in the
      // collapsed header instead of being cut off with it (#264).
      await setChatPanelWidth(page, 320);
      const header = page
        .locator('[data-run-status="completed"]')
        .getByRole("button", { name: /Worked for/ });
      const errorCount = header.getByText("· 1 error", { exact: true });
      await expect(errorCount).toBeVisible();
      await expect(page.getByRole("status", { name: "Run outcome: Unresolved errors", exact: true })).toBeVisible();
      const countBox = (await errorCount.boundingBox())!;
      const chevronBox = (await header.locator("svg").last().boundingBox())!;
      expect(countBox.x + countBox.width).toBeLessThanOrEqual(chevronBox.x);

      for (const width of [320, 480]) {
        await setChatPanelWidth(page, width);
        expect(await chatOverflow(page)).toEqual([]);
        expect(await chatScrollsHorizontally(page)).toBe(false);
      }

      // The panel cannot be squeezed below its minimum width; dragging it far
      // past that closes it, and the toolbar button brings it back.
      const panel = page.getByTestId("chat-panel");
      const sash = page.locator('[class*="sash-module_sash"]').first();
      const dragSash = async (toX: number) => {
        const box = (await sash.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(toX, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();
      };
      await dragSash(200);
      expect((await panel.boundingBox())!.width).toBeGreaterThanOrEqual(300);
      await dragSash(20);
      await expect(panel).toBeHidden();
      await page.getByRole("button", { name: "Show chat panel" }).click();
      await expect(panel).toBeVisible();
      expect((await panel.boundingBox())!.width).toBeGreaterThanOrEqual(300);
      await setChatPanelWidth(page, 480);

      // The pasted log renders as a monospace block inside the bubble.
      await expect(page.locator('[role="log"] pre', { hasText: "import Home from" })).toBeVisible();

      // Numbered steps keep their numbers, nested bullets their discs (#286).
      const step = page.locator('[data-streamdown="ordered-list"] > li', { hasText: "Run the dev server" });
      await expect(step.locator("xpath=..")).toHaveCSS("list-style-type", "decimal");
      await expect(page.locator('[data-streamdown="ordered-list"] [data-streamdown="unordered-list"]')).toHaveCSS("list-style-type", "disc");

      // Long chip lists collapse to the first six.
      const more = liveRun.getByRole("button", { name: "+11 more" });
      await expect(more).toBeVisible();
      await more.click();
      await expect(liveRun.getByRole("button", { name: "components.json" })).toBeVisible();

      // Expanding a clamped message keeps it inside the panel too. The live run
      // re-renders the log, which can swallow a click, so retry it.
      await expect(async () => {
        await page.getByRole("button", { name: "Show more" }).first().click({ force: true });
        await expect(page.getByRole("button", { name: "Show less" })).toBeVisible({
          timeout: 2_000,
        });
      }).toPass();
      expect(await chatOverflow(page)).toEqual([]);

      // Phone layout: the chat is a full-width tab.
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect(liveRun).toBeVisible();
      expect(await chatOverflow(page)).toEqual([]);

      // The failed step's truncated error expands from the keyboard or a tap,
      // not only a hover tooltip (#327).
      await page
        .locator('[data-run-status="completed"]')
        .getByRole("button", { name: /Worked for/ })
        .click();
      const stepError = page.getByRole("button", { name: /^Patch failed/ });
      await expect(stepError).toHaveAttribute("aria-expanded", "false");
      await stepError.focus();
      await page.keyboard.press("Enter");
      await expect(stepError).toHaveAttribute("aria-expanded", "true");
      expect(await stepError.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await chatOverflow(page)).toEqual([]);
    } finally {
      await stopRun();
    }

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
