import { expect, test } from "@playwright/test";

import {
  chatOverflow,
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

      for (const width of [320, 480]) {
        await setChatPanelWidth(page, width);
        expect(await chatOverflow(page)).toEqual([]);
      }

      // The pasted log renders as a monospace block inside the bubble.
      await expect(page.locator('[role="log"] pre', { hasText: "import Home from" })).toBeVisible();

      // Long chip lists collapse to the first six.
      const more = liveRun.getByRole("button", { name: "+11 more" });
      await expect(more).toBeVisible();
      await more.click();
      await expect(liveRun.getByRole("button", { name: "components.json" })).toBeVisible();

      // Expanding a clamped message keeps it inside the panel too.
      await page.getByRole("button", { name: "Show more" }).first().click({ force: true });
      await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
      expect(await chatOverflow(page)).toEqual([]);

      // Phone layout: the chat is a full-width tab.
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect(liveRun).toBeVisible();
      expect(await chatOverflow(page)).toEqual([]);
    } finally {
      await stopRun();
    }

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
