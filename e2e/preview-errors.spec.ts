import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv } from "./preview-fixtures";

// A static page, so the in-browser preview needs no npm install.
const THROWING_PAGE =
  "<!doctype html>\n<html><head><title>Broken</title></head><body><h1>Broken</h1>" +
  "<script>throw new Error('Static exploded');</script></body></html>\n";

test.describe("preview runtime error banner (#223)", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs Clerk and Convex fixture env",
  );

  test("reports the app's error, flags the finished run and guards repeat fixes", async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);

    await signIn(page);
    const user = await userConvexClient(page);
    const projectId = await user.mutation(api.projects.create, {
      name: `e2e-preview-errors-${Date.now()}`,
    });
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    await system.mutation(api.system.createFile, {
      internalKey,
      projectId,
      name: "index.html",
      content: THROWING_PAGE,
    });
    // A finished run, so the run block has something to flag.
    const conversationId = await user.mutation(api.conversations.create, {
      projectId,
      title: "Preview errors",
    });
    const create = (role: "user" | "assistant", content: string, status?: "processing") =>
      system.mutation(api.system.createMessage, {
        internalKey,
        conversationId,
        projectId,
        role,
        content,
        status,
      });
    await create("user", "Make the page");
    const run = await create("assistant", "", "processing");
    const now = Date.now();
    await system.mutation(api.system.upsertMessageSteps, {
      internalKey,
      messageId: run,
      steps: [
        {
          id: "edit",
          kind: "tool",
          tool: "updateFile",
          targets: ["index.html"],
          status: "done",
          startedAt: now,
          endedAt: now,
        },
      ],
    });
    await system.mutation(api.system.updateMessageContent, {
      internalKey,
      messageId: run,
      content: "Made the page.",
    });
    try {

      const banner = page.getByRole("alert").filter({ hasText: "Static exploded" });
      // A width change can swap the IDE layout and remount the preview, so each
      // width gets its own page load.
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/projects/${projectId}?engine=webcontainer&view=preview`);
        await expect(banner).toContainText("Runtime error", { timeout: 120_000 });
        await expect(banner).toHaveCount(1);
        for (const theme of ["light", "dark"] as const) {
          // In place, the way next-themes syncs a change from another tab.
          await page.evaluate((value) => {
            localStorage.setItem("theme", value);
            window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: value }));
          }, theme);
          await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
          await expect(banner.getByRole("button", { name: "Fix with AI" })).toBeInViewport();
          await page.screenshot({ path: testInfo.outputPath(`banner-${theme}-${width}.png`) });
        }
      }

      // Only the preview iframe may report errors; this page is not it.
      await page.evaluate(() =>
        window.postMessage(
          { source: "codenaya-preview", version: 1, kind: "runtime", message: "Forged error" },
          "*",
        ),
      );
      await page.waitForTimeout(500);
      await expect(banner).not.toContainText("Forged error");

      await banner.getByRole("button", { name: "Show logs" }).click();
      await expect(page.getByRole("button", { name: "Hide logs" }).first()).toBeVisible();

      // The route is stubbed so no agent run (or model spend) starts.
      const sent: string[] = [];
      await page.route("**/api/messages", async (route) => {
        sent.push((route.request().postDataJSON() as { message: string }).message);
        // Slow enough for a second click to land mid-send.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await route.fulfill({ status: 200, json: {} });
      });
      // The finished run doesn't claim success over the broken preview.
      const runBlock = page.locator('[data-run-status="completed"]');
      await expect(runBlock).toContainText("Finished");
      await expect(runBlock).toContainText("preview has 1 error");
      await runBlock.getByRole("button", { name: "Fix preview errors" }).dblclick();
      await expect(banner).toContainText("Sending the fix");
      await expect(banner.getByRole("button", { name: "Fix with AI" })).toBeDisabled();
      await expect(banner).not.toContainText("Sending the fix");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("runtime error");
      expect(sent[0]).toContain("Static exploded");

      // The banner shares the same fix and its two-attempt limit.
      await banner.getByRole("button", { name: "Fix with AI" }).click();
      await expect.poll(() => sent.length).toBe(2);
      await expect(banner).toContainText("Still failing");
      await expect(banner.getByRole("button", { name: "Fix with AI" })).toHaveCount(0);
      await expect(runBlock.getByRole("button", { name: "Fix preview errors" })).toHaveCount(0);

      await banner.getByRole("button", { name: "Dismiss error" }).click();
      await expect(banner).toHaveCount(0);
    } finally {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
  });
});
