import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

/** Stubs the sandbox so the boot resolves at once; returns the boot request count. */
const stubSandbox = async (page: Page) => {
  const counter = { boots: 0 };
  await page.route("**/api/sandbox", (route) => {
    counter.boots += 1;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
    });
  });
  // File sync and teardown of the stubbed sandbox.
  await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
  return counter;
};

/** A project with no package.json and a run in progress: the first build. */
const startFirstBuild = async (page: Page, name: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const projectId = await seedPreviewProject(page, name);
  const conversationId = await (await userConvexClient(page)).mutation(api.conversations.create, {
    projectId,
    title: `Auto-open ${Date.now()}`,
  });
  const runs: Id<"messages">[] = [];

  const startRun = async () => {
    const messageId = await system.mutation(api.system.createMessage, {
      internalKey,
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
    });
    runs.push(messageId);
    return {
      complete: () =>
        system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" }),
    };
  };

  return {
    projectId,
    run: await startRun(),
    startRun,
    writePackageJson: () =>
      system.mutation(api.system.createFile, {
        internalKey,
        projectId,
        name: "package.json",
        content: "{}\n",
      }),
    cleanup: () =>
      Promise.all(
        runs.map((messageId) =>
          system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" }),
        ),
      ),
  };
};

test.describe("first build auto-opens the preview", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  for (const [device, width, height] of [["desktop", 1440, 900], ["tablet", 768, 1024]] as const) {
    test(`boots once package.json lands and shows Preview (${device})`, async ({ page }, testInfo) => {
      test.setTimeout(150_000);
      const errors = collectConsoleErrors(page);
      const sandbox = await stubSandbox(page);
      await page.setViewportSize({ width, height });
      await signIn(page);
      const build = await startFirstBuild(page, `e2e-preview-auto-open-${device}`);

      try {
        await page.goto(`/projects/${build.projectId}`);
        // Desktops open on Preview for the first build (#337); tablets stay on the Chat tab.
        const startTab = page.getByRole("tab", { name: device === "desktop" ? "Preview" : "Chat" });
        const previewTab = page.getByRole("tab", { name: "Preview" });
        const iframe = page.locator('iframe[title="Preview"]');
        const stillBuilding = page.getByRole("status", { name: "Still building" });
        await expect(startTab).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
        await page.waitForTimeout(5_000);
        expect(sandbox.boots).toBe(0);

        // Pre-warm: the sandbox boots while the run is still writing.
        await build.writePackageJson();
        await expect.poll(() => sandbox.boots, { timeout: 30_000 }).toBeGreaterThan(0);
        await expect(startTab).toHaveAttribute("aria-selected", "true");
        if (device === "desktop") {
          // The stubbed sandbox is running mid-run: the app shows under the bar.
          await expect(iframe).toBeVisible({ timeout: 30_000 });
          await expect(stillBuilding).toBeVisible();
        }
        await page.screenshot({ path: testInfo.outputPath(`during-build-${device}.png`) });

        await build.run.complete();
        await expect(previewTab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
        await expect(iframe).toBeVisible();
        await expect(page.getByRole("status", { name: "Building your app" })).toBeHidden();
        await expect(stillBuilding).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath(`auto-opened-${device}.png`) });

        // Later runs leave the selected tab alone and show no bar.
        const codeTab = page.getByRole("tab", { name: "Code" });
        await codeTab.click();
        const second = await build.startRun();
        await page.waitForTimeout(2_000);
        await previewTab.click();
        await expect(page.getByText("Agent working")).toBeVisible();
        await expect(stillBuilding).toBeHidden();
        await codeTab.click();
        await second.complete();
        await page.waitForTimeout(3_000);
        await expect(codeTab).toHaveAttribute("aria-selected", "true");
      } finally {
        await build.cleanup();
      }

      expect(errors).toEqual([]);
    });
  }

  test("keeps the tab the user picked during the first build", async ({ page }) => {
    test.setTimeout(150_000);
    const errors = collectConsoleErrors(page);
    await stubSandbox(page);
    await page.setViewportSize({ width: 768, height: 1024 });
    await signIn(page);
    const build = await startFirstBuild(page, "e2e-preview-auto-open-picked");

    try {
      await page.goto(`/projects/${build.projectId}`);
      const codeTab = page.getByRole("tab", { name: "Code" });
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true", {
        timeout: 60_000,
      });
      // The file tree is out of the accessibility tree behind the chat; give the files a moment to load.
      await page.waitForTimeout(5_000);
      await codeTab.click();
      await build.writePackageJson();
      await page.waitForTimeout(2_000);

      await build.run.complete();
      await page.waitForTimeout(3_000);
      await expect(codeTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await build.cleanup();
    }

    expect(errors).toEqual([]);
  });

  test("offers the preview in a toast on phones", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const errors = collectConsoleErrors(page);
    await stubSandbox(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    const build = await startFirstBuild(page, "e2e-preview-auto-open-phone");

    try {
      await page.goto(`/projects/${build.projectId}`);
      const chatTab = page.getByRole("tab", { name: "Chat" });
      await expect(chatTab).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
      // The file tree is out of the accessibility tree behind the chat; give the files a moment to load.
      await page.waitForTimeout(5_000);
      await build.writePackageJson();
      await page.waitForTimeout(2_000);

      await build.run.complete();
      const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Preview ready" });
      await expect(toast).toBeVisible({ timeout: 30_000 });
      await expect(chatTab).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(500); // enter animation
      await page.screenshot({ path: testInfo.outputPath("toast-phone.png") });

      await toast.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('iframe[title="Preview"]')).toBeVisible();
      await expect(toast).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath("opened-phone.png") });
    } finally {
      await build.cleanup();
    }

    expect(errors).toEqual([]);
  });
});
