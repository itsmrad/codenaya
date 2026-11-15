import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasInternalKey } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

// Regression for #608: one stray Esc during a first build stopped it after 0
// steps. Esc now asks for a second press before it stops the run.
test.describe("chat: Esc twice stops a run", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("one Esc keeps the run going, a second one stops it", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;

    await signIn(page);

    // A project of its own with one run in progress. No agent runs: the
    // message is created as processing, so no model is called.
    const user = await userConvexClient(page);
    const project = await user.mutation(api.projects.create, {
      name: `e2e-esc-stop-${Date.now()}`,
    });
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const conversationId = await user.mutation(api.conversations.create, {
      projectId: project,
      title: `Esc stop check ${Date.now()}`,
    });
    const create = (role: "user" | "assistant", content: string) =>
      system.mutation(api.system.createMessage, {
        internalKey,
        conversationId,
        projectId: project,
        role,
        content,
        status: role === "assistant" ? "processing" : undefined,
      });
    await create("user", "Build a habit tracker");
    const runId = await create("assistant", "");

    const cancels: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/messages/cancel")) cancels.push(request.postDataJSON());
    });

    try {
      await page.goto(`/projects/${project}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await expect(page.locator('[data-run-status="running"]')).toBeVisible({ timeout: 60_000 });

      // Focus on the page itself, as after clicking away from the composer.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await expect(page.getByText("Press Esc again to stop")).toBeVisible();
      await expect(page.locator('[data-run-status="running"]')).toBeVisible();
      expect(cancels).toEqual([]);

      const cancel = page.waitForRequest((request) => request.url().includes("/api/messages/cancel"));
      await page.keyboard.press("Escape");
      expect((await cancel).postDataJSON()).toEqual({ projectId: project, source: "esc" });
      await expect(page.locator('[data-run-status="cancelled"]')).toBeVisible();
      await expect(page.getByText("Stopped after 0 steps")).toBeVisible();
      expect(cancels).toHaveLength(1);
    } finally {
      await system
        .mutation(api.system.updateMessageStatus, { internalKey, messageId: runId, status: "cancelled" })
        .catch(() => {});
      await user.mutation(api.projects.remove, { id: project }).catch(() => {});
    }

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
