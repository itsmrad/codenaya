import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasInternalKey } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

// Regression for #142: a run lost after dispatch kept a live "Thinking…"
// timer, Stop in the composer and a locked model switcher, forever.
test.describe("chat when an agent run stops responding", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("shows the run as stalled and gives the composer back", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;

    await signIn(page);

    // A project of its own, with one conversation (so the active one) whose
    // run made some progress and then went silent. In the shared fixture
    // project another spec's newer conversation could become the active one.
    const user = await userConvexClient(page);
    const project = await user.mutation(api.projects.create, {
      name: `e2e-stalled-run-${Date.now()}`,
    });
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const conversationId = await user.mutation(api.conversations.create, {
      projectId: project,
      title: `Stalled run check ${Date.now()}`,
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
    const now = Date.now();
    await system.mutation(api.system.upsertMessageSteps, {
      internalKey,
      messageId: runId,
      steps: [
        { id: "folder", kind: "tool", tool: "createFolder", targets: ["src"], status: "done", startedAt: now, endedAt: now },
        { id: "files", kind: "tool", tool: "createFiles", targets: ["src/App.tsx"], status: "running", startedAt: now },
      ],
    });

    try {
      // Fake timers from the start, so the stall deadline can be jumped to.
      await page.clock.install();
      await page.goto(`/projects/${project}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      const composer = page.getByPlaceholder("Describe a change or ask a question…");
      const modelSwitcher = page.getByRole("combobox", { name: "Agent model" });

      await expect(page.locator('[data-run-status="running"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(composer).toBeDisabled();

      // Past the stall threshold with no new steps.
      await page.clock.fastForward("06:00");

      const run = page.locator('[data-run-status="stalled"]');
      await expect(run).toBeVisible();
      await expect(run.getByText("Stopped responding")).toBeVisible();
      await expect(run.getByText("Thinking…")).toHaveCount(0);
      await expect(page.getByText("This is taking too long.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

      // Retry is the only action: the composer offers Send, not Stop.
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await expect(composer).toBeEnabled();
      await expect(modelSwitcher).toBeEnabled();
      await composer.fill("Try again");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    } finally {
      await system.mutation(api.system.updateMessageStatus, {
        internalKey,
        messageId: runId,
        status: "cancelled",
      });
      await user.mutation(api.projects.remove, { id: project }).catch(() => {});
    }

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
