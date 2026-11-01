import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

// A project with no conversation (blank create, Duplicate, Remix, import)
// opens on the chat empty state, with starters that fit the project (#312).
test.describe("chat empty state without a conversation", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  test("blank and duplicated projects show starters; a starter starts a run", async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectConsoleErrors(page);
    await signIn(page);
    const user = await userConvexClient(page);
    const name = `e2e-empty-chat-${Date.now()}`;
    const projectIds: Id<"projects">[] = [];

    try {
      const blankId = await user.mutation(api.projects.create, { name });
      projectIds.push(blankId);

      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/projects/${blankId}?engine=webcontainer`);
        await expect(page.getByText("What do you want to build?")).toBeVisible();
        await expect(page.getByRole("button", { name: /landing page/ })).toBeVisible();
      }

      // A copy has files but no conversation.
      await user.mutation(api.files.createFile, {
        projectId: blankId,
        name: "index.html",
        content: "<h1>Hello</h1>",
      });
      const copyId: Id<"projects"> = await user.mutation(api.projects.duplicate, { id: blankId });
      projectIds.push(copyId);

      await page.goto(`/projects/${copyId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await expect(page.getByText(`Continue building ${name} (copy)`)).toBeVisible();
      const send = page.waitForRequest(
        (request) => request.url().endsWith("/api/messages") && request.method() === "POST",
      );
      await page.getByRole("button", { name: "Add dark mode" }).click();

      // The starter creates the conversation and sends itself as its first message.
      await expect(page.getByText("Add dark mode")).toBeVisible();
      const body = (await send).postDataJSON() as { conversationId: string; message: string };
      expect(body.message).toBe("Add dark mode");
      const conversations = await user.query(api.conversations.getByProject, { projectId: copyId });
      expect(conversations.map((conversation) => conversation._id)).toEqual([body.conversationId]);

      // Stopping is best-effort: cancelling needs the Inngest server.
      const stop = page.getByRole("button", { name: "Stop" });
      if (await stop.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
        await stop.click();
      }

      expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
    } finally {
      for (const id of projectIds) {
        await user.mutation(api.projects.remove, { id }).catch(() => {});
      }
    }
  });
});
