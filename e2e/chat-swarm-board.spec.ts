import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { EMPTY_CHAT_TITLE, hasInternalKey, seedSwarmConversation } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

// The swarm board (S4): seeded agentTasks rows stream status changes in, and
// the composer's Swarm mode sends mode "swarm". No LLM runs.
test.describe("chat swarm board", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("shows workers live, expands a log and cancels unfinished workers", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await signIn(page);
    const user = await userConvexClient(page);
    const projectId = await user.mutation(api.projects.create, { name: `e2e-swarm-board-${Date.now()}` });
    try {
      const swarm = await seedSwarmConversation(page, projectId);
      await page.goto(`/projects/${projectId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

      const board = page.getByRole("region", { name: "Swarm board" });
      await expect(board.getByText(/^Swarm · 3 workers · \d+:\d\d · 1 done$/)).toBeVisible({ timeout: 60_000 });
      await expect(board.getByText("Delegated 3 tasks")).toBeVisible();
      const row = (title: string) => board.getByRole("button", { name: new RegExp(title) });
      await expect(row("Hero section")).toContainText("Done");
      await expect(row("Pricing table")).toContainText("Running");
      await expect(row("Footer")).toContainText("Queued");

      // Expanding a worker shows its own step log.
      const hero = row("Hero section");
      await expect(hero).toHaveAttribute("aria-expanded", "false");
      await hero.click();
      await expect(hero).toHaveAttribute("aria-expanded", "true");
      await expect(board.getByText("Added the hero section.")).toBeVisible();

      // A status change streams in without a reload.
      await swarm.finishPricing();
      await expect(row("Pricing table")).toContainText("Done");
      await expect(board.getByText(/ · 2 done$/)).toBeVisible();

      // Stopping the parent run shows its unfinished workers as cancelled.
      await swarm.cancel();
      await expect(row("Footer")).toContainText("Cancelled");
      await expect(row("Hero section")).toContainText("Done");
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme);
        await test.info().attach(`swarm-board-${theme}`, { body: await board.screenshot(), contentType: "image/png" });
      }
    } finally {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("the Swarm toggle sends mode swarm", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const user = await userConvexClient(page);
    const projectId = await user.mutation(api.projects.create, { name: `e2e-swarm-toggle-${Date.now()}` });
    try {
      // Intercepted: the route's own swarm support is S3's, and no run starts here.
      const sent = new Promise<Record<string, unknown>>((resolve) =>
        page.route("**/api/messages", async (route) => {
          resolve(route.request().postDataJSON());
          await route.abort();
        }),
      );
      await page.goto(`/projects/${projectId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.getByRole("button", { name: "New conversation" }).click();
      await expect(page.getByText(EMPTY_CHAT_TITLE)).toBeVisible();

      const modes = page.getByRole("radiogroup", { name: "Message mode" });
      await modes.getByRole("radio", { name: "Build" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(modes.getByRole("radio", { name: "Ask / Plan", exact: true })).toBeChecked();
      await modes.getByRole("radio", { name: "Swarm" }).click();
      await expect(modes.getByRole("radio", { name: "Swarm" })).toBeChecked();
      await expect(modes.getByRole("radio", { name: "Build" })).not.toBeChecked();

      const input = page.getByPlaceholder("Describe a change or ask a question…");
      await input.fill("landing page");
      await input.press("Enter");
      expect(await sent).toMatchObject({ message: "landing page", mode: "swarm" });
    } finally {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
  });
});
