import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-first-build";

test.describe("first build preview", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("shows the build while the agent writes the first files, then boots", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    let sandboxRequests = 0;
    await page.route("**/api/sandbox", (route) => {
      sandboxRequests += 1;
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
      });
    });
    // File sync and teardown of the stubbed sandbox.
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const conversationId = await (await userConvexClient(page)).mutation(api.conversations.create, {
      projectId,
      title: `First build ${Date.now()}`,
    });
    const messageId = await system.mutation(api.system.createMessage, {
      internalKey,
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
    });

    try {
      await system.mutation(api.system.upsertMessageSteps, {
        internalKey,
        messageId,
        steps: [
          { id: "create", kind: "tool", tool: "createFiles", targets: ["src/App.tsx"], status: "running", startedAt: Date.now() },
        ],
      });

      await page.goto(`/projects/${projectId}?view=preview`);
      const building = page.getByRole("status", { name: "Building your app" });
      await expect(building).toBeVisible({ timeout: 60_000 });
      await expect(building).toContainText("Preview starts when the first build finishes");
      await expect(building).toContainText("Creating App.tsx");
      await expect(building.getByRole("list", { name: "Files written so far" })).toContainText("index.html");

      for (const [name, width, height] of [["phone", 375, 812], ["tablet", 768, 1024], ["desktop", 1440, 900]] as const) {
        await page.setViewportSize({ width, height });
        await expect(building).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`building-${name}.png`) });
      }

      // package.json alone doesn't boot it: the run is still writing.
      await system.mutation(api.system.createFile, {
        internalKey,
        projectId,
        name: "package.json",
        content: "{}\n",
      });
      await expect(building).toContainText("package.json");
      await page.waitForTimeout(3_000);
      expect(sandboxRequests).toBe(0);

      await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" });
      await expect(page.locator('iframe[title="Preview"]')).toBeVisible({ timeout: 30_000 });
      await expect(building).toBeHidden();
      expect(sandboxRequests).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath("booted-desktop.png") });
    } finally {
      await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" });
    }

    expect(errors).toEqual([]);
  });
});
