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

  test("shows the build card until the sandbox runs, then the live preview under a bar", async ({ page }, testInfo) => {
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
      await expect(building).toContainText("The preview appears as soon as your app starts");
      await expect(building).toContainText("Creating App.tsx");
      // #478: the list is what the run wrote, not the seeded files.
      const written = building.getByRole("list", { name: "Files written so far" });
      await expect(written).not.toContainText("index.html");
      await system.mutation(api.system.upsertMessageSteps, {
        internalKey,
        messageId,
        steps: [
          { id: "create", kind: "tool", tool: "createFiles", targets: ["src/App.tsx"], status: "done", startedAt: Date.now(), endedAt: Date.now() },
          { id: "update", kind: "tool", tool: "updateFile", targets: ["src/index.css"], status: "running", startedAt: Date.now() },
        ],
      });
      await expect(written).toContainText("src/App.tsx");
      await expect(building.locator(".animate-ping")).toHaveCount(0);

      for (const [name, width, height] of [["desktop", 1440, 900], ["phone", 375, 812], ["tablet", 768, 1024]] as const) {
        await page.setViewportSize({ width, height });
        await expect(building).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`building-${name}.png`) });
      }

      // No package.json, nothing to boot yet.
      expect(sandboxRequests).toBe(0);

      // package.json boots the sandbox while the run is still writing. The stub is
      // running at once, so the card gives way to the app under the bar (#337).
      // Crossing the 1024px breakpoint remounts the IDE, which then can't tell a
      // first build once package.json exists. End the card checks in the compact
      // layout so that remount finishes before writing package.json;
      // preview-auto-open.spec.ts checks the bar on desktop.
      await page.setViewportSize({ width: 375, height: 812 });
      await system.mutation(api.system.createFile, {
        internalKey,
        projectId,
        name: "package.json",
        content: "{}\n",
      });
      await expect.poll(() => sandboxRequests, { timeout: 30_000 }).toBeGreaterThan(0);
      const iframe = page.locator('iframe[title="Preview"]');
      const stillBuilding = page.getByRole("status", { name: "Still building" });
      await expect(iframe).toBeVisible({ timeout: 30_000 });
      await expect(building).toBeHidden();
      await expect(stillBuilding).toContainText("Creating App.tsx");
      for (const [name, width, height] of [["phone", 375, 812], ["tablet", 768, 1024]] as const) {
        await page.setViewportSize({ width, height });
        await expect(stillBuilding).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`still-building-${name}.png`) });
      }

      await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" });
      await expect(stillBuilding).toBeHidden({ timeout: 30_000 });
      await expect(iframe).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("booted-tablet.png") });
    } finally {
      await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" });
    }

    expect(errors).toEqual([]);
  });
});
