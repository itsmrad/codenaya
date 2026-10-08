import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/**
 * Fresh "Vite + React" agent apps boot in the E2B preview with no Vite error
 * overlay (#190). Runs the real agent (platform OpenRouter model) and a real
 * sandbox, so it is opt-in: E2E_LIVE_AGENT=1, the Inngest dev server serving
 * this app, E2B_API_KEY and E2B_TEMPLATE (the Node 22 template).
 */

const PROMPTS = [
  "Build a Vite + React todo app with filters for all, active and completed tasks",
  "Build a Vite + React landing page for a specialty coffee roastery",
  "Build a Vite + React pomodoro timer with work and break sessions",
  "Build a Vite + React expense tracker with a monthly summary",
  "Build a Vite + React recipe browser with search and category filters",
];

test.describe("agent Vite + React scaffold", () => {
  test.skip(
    !process.env.E2E_LIVE_AGENT ||
      !hasClerkCredentials() ||
      !process.env.E2B_API_KEY ||
      !process.env.E2B_TEMPLATE,
    "Opt-in live run: needs E2E_LIVE_AGENT=1, Inngest dev, Clerk, E2B_API_KEY and E2B_TEMPLATE",
  );

  for (const [index, prompt] of PROMPTS.entries()) {
    test(`fresh app ${index + 1} boots without a Vite error overlay`, async ({ page }) => {
      test.setTimeout(20 * 60_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      const errors = collectConsoleErrors(page);

      await signIn(page);
      const user = await userConvexClient(page);
      const projectId: Id<"projects"> = await user.mutation(api.projects.create, {
        name: `e2e-vite-scaffold-${index + 1}-${Date.now()}`,
      });

      await page.goto(`/projects/${projectId}`);
      // The dev-tools badge covers the composer's bottom-left corner.
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.getByRole("button", { name: "New conversation" }).click();
      const input = page.getByPlaceholder("Describe a change or ask a question…");
      await input.fill(prompt);
      await input.press("Enter");

      // "Worked for …" replaces the live run block once the agent finishes.
      await expect(page.getByRole("button", { name: /^Worked/ }).last()).toBeVisible({
        timeout: 15 * 60_000,
      });

      await page.getByRole("tab", { name: "Preview" }).click();
      const preview = page.frameLocator('iframe[title="Preview"]');
      // Whichever comes first: the app's first paint or Vite's error overlay.
      await expect(preview.locator("#root > *, vite-error-overlay").first()).toBeAttached({
        timeout: 4 * 60_000,
      });
      // Late transform errors (a missing import) arrive after the first paint.
      await page.waitForTimeout(5_000);
      await expect(preview.locator("vite-error-overlay")).toHaveCount(0);

      await test.info().attach(`app-${index + 1}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(errors).toEqual([]);
      // Kept on failure so the generated files can be inspected.
      await user.mutation(api.projects.remove, { id: projectId });
    });
  }
});
