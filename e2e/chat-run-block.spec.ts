import { expect, test } from "@playwright/test";

import { hasInternalKey, seedRunConversation } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

// The agent-run block (#182): live loader, "Thought for Ns", non-file chips
// and the changed-files row of a finished run.
test.describe("chat run block", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CODENAYA_CONVEX_INTERNAL_KEY and NEXT_PUBLIC_CONVEX_URL",
  );

  test("shows the live loader, run details and changed files", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedPreviewProject(page, "e2e chat run block");
    const stopRun = await seedRunConversation(page, projectId);
    try {
      await page.goto(`/projects/${projectId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

      // Live run: the pixel loader animates, and freezes under reduced motion.
      const liveRun = page.locator('[data-run-status="running"]');
      const loaderCell = liveRun.locator('[data-slot="run-loader"] > span').first();
      await expect(loaderCell).toBeVisible({ timeout: 60_000 });
      const animationName = () => loaderCell.evaluate((cell) => getComputedStyle(cell).animationName);
      expect(await animationName()).toBe("pixel-on");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await animationName()).toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });

      // Finished run: changed files show while collapsed; deleted/read files don't.
      const doneRun = page.locator('[data-run-status="completed"]');
      const changed = doneRun.locator('[data-slot="changed-files"]');
      await expect(changed.getByRole("button")).toHaveText(["pricing.css", "index.html"]);

      // Expanded: the thinking row reports its duration and the skill chip
      // is a plain label, not a file link.
      await doneRun.getByRole("button", { name: /Worked for/ }).click();
      await expect(doneRun.getByText("Thought for 4s")).toBeVisible();
      await expect(doneRun.getByText("frontend-design")).toBeVisible();
      await expect(doneRun.getByRole("button", { name: "frontend-design" })).toHaveCount(0);

      // A changed-file chip opens the file in the editor.
      await changed.getByRole("button", { name: "index.html" }).click();
      await expect(page.getByRole("tab", { name: /index\.html/ })).toBeVisible();
    } finally {
      await stopRun();
    }

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
