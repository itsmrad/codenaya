import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasInternalKey, seedSwarmConversation } from "./chat-fixtures";
import { hasClerkCredentials, signInAsSpecUser } from "./clerk-auth";
import { userConvexClient } from "./convex-client";

// #525: the Agent board workspace mode opens projects on the swarm board,
// seeded as in chat-swarm-board.spec.ts. No LLM runs.
test.describe("agent board workspace mode", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("opens a project on the board, with the preview a tab away and no code", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // A user of its own: the mode is account-wide and would change other specs' layout.
    await signInAsSpecUser(page, "board-mode");
    const user = await userConvexClient(page);
    test.skip(!(await user.query(api.swarm.isEnabled, {})), "swarm is off on this deployment");

    await page.goto("/settings/workspace");
    const board = page.getByRole("radio", { name: /Agent board/ });
    await expect(board).toBeEnabled();
    await board.click();
    await expect.poll(() => user.query(api.userPreferences.getWorkspaceMode, {})).toBe("board");

    const projectId = await user.mutation(api.projects.create, { name: `e2e-board-mode-${Date.now()}` });
    try {
      await seedSwarmConversation(page, projectId);
      await page.goto(`/projects/${projectId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

      const views = page.getByRole("tablist", { name: "Workspace views" });
      await expect(views.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true", {
        timeout: 60_000,
      });
      await expect(
        page.getByRole("region", { name: "Agent board" }).getByRole("region", { name: "Swarm board" }),
      ).toBeVisible();
      await expect(views.getByRole("tab", { name: "Code" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open code for this session" })).toBeVisible();

      await views.getByRole("tab", { name: "Preview" }).click();
      await expect(views.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    } finally {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
      // Leave the spec user on the default layout.
      await user.mutation(api.userPreferences.setWorkspaceMode, { workspaceMode: "ide" }).catch(() => {});
    }
  });
});
