import { expect, type Page, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasInternalKey } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

/** A fresh conversation (the active one) with a live run; returns the run's controls. */
const seedLiveRun = async (page: Page, projectId: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const project = projectId as Id<"projects">;
  const conversationId = await (await userConvexClient(page)).mutation(api.conversations.create, {
    projectId: project,
    title: `Follow-up check ${Date.now()}`,
  });
  const create = (role: "user" | "assistant", content: string, status?: "processing") =>
    system.mutation(api.system.createMessage, { internalKey, conversationId, projectId: project, role, content, status });
  await create("user", "Build a landing page");
  const messageId = await create("assistant", "", "processing");
  return {
    complete: () => system.mutation(api.system.updateMessageContent, { internalKey, messageId, content: "Built it." }),
    cancel: () => system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" }),
  };
};

// #257 slice 1: one follow-up typed during a run is sent when the run ends.
test.describe("queued follow-up", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CODENAYA_CONVEX_INTERNAL_KEY and NEXT_PUBLIC_CONVEX_URL",
  );

  test("is sent once the run completes, and handed back when a run is stopped", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    await signIn(page);
    const projectId = await seedPreviewProject(page, "e2e chat follow-up");
    // No real run: the follow-up's send is answered here.
    const sent: string[] = [];
    await page.route("**/api/messages", async (route) => {
      sent.push((route.request().postDataJSON() as { message: string }).message);
      await route.fulfill({ status: 200, json: {} });
    });

    const run = await seedLiveRun(page, projectId);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await expect(page.locator('[data-run-status="running"]')).toBeVisible({ timeout: 60_000 });

    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    const queued = page.getByRole("status").filter({ hasText: "Queued" });
    await composer.fill("Add a footer");
    await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
    await composer.press("Enter");
    await expect(queued).toContainText("Add a footer");
    await expect(composer).toHaveValue("");
    // A second Enter in the empty composer must not stop the run (#578 review).
    await composer.press("Enter");
    await expect(page.locator('[data-run-status="running"]')).toBeVisible();
    await expect(queued).toContainText("Add a footer");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();

    // Edit puts it back in the composer; queue it again, changed.
    await queued.getByRole("button", { name: "Edit queued message" }).click();
    await expect(queued).toBeHidden();
    await expect(composer).toHaveValue("Add a footer");
    await composer.fill("Add a footer with links");
    await composer.press("Enter");
    await expect(queued).toContainText("Add a footer with links");
    expect(sent).toEqual([]);

    await run.complete();
    await expect.poll(() => sent).toEqual(["Add a footer with links"]);
    await expect(queued).toBeHidden();

    // A stopped run doesn't send it: the text comes back to the composer.
    const stopped = await seedLiveRun(page, projectId);
    await expect(page.locator('[data-run-status="running"]')).toBeVisible({ timeout: 60_000 });
    await composer.fill("Then a pricing table");
    await composer.press("Enter");
    await expect(queued).toContainText("Then a pricing table");
    await stopped.cancel();
    await expect(page.getByText("your queued message wasn't sent")).toBeVisible();
    await expect(composer).toHaveValue("Then a pricing table");
    expect(sent).toEqual(["Add a footer with links"]);

    // Remove drops it without sending.
    const removed = await seedLiveRun(page, projectId);
    await expect(page.locator('[data-run-status="running"]')).toBeVisible({ timeout: 60_000 });
    await composer.press("Enter");
    await queued.getByRole("button", { name: "Remove queued message" }).click();
    await expect(queued).toBeHidden();
    await removed.complete();
    await expect(page.locator('[data-run-status="running"]')).toBeHidden();
    expect(sent).toEqual(["Add a footer with links"]);
    expect(errors).toEqual([]);
  });
});
