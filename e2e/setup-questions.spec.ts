import { expect, type Page, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const DETAILED_PROMPT =
  "Build a habit tracker for small teams with a weekly dashboard, streaks per person, email reminders and a minimal black and white look";

// #344: a short first prompt gets up to 3 chip questions; Skip costs nothing.
test.describe("setup questions before the first build", () => {
  test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("ask on a short prompt only; Skip sends it unchanged, answers go to the prompt and the instructions", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page);
    const user = await userConvexClient(page);
    // The created project is a throwaway blank one: no real first build runs.
    const projectId: Id<"projects"> = await user.mutation(api.projects.create, { name: `e2e-setup-questions-${Date.now()}` });
    const prompts: string[] = [];
    await page.route("**/api/projects/create-with-prompt", async (route) => {
      prompts.push((route.request().postDataJSON() as { prompt: string }).prompt);
      await route.fulfill({ status: 200, json: { projectId } });
    });
    const questions = page.getByRole("dialog", { name: "A few quick choices" });
    const submit = async (prompt: string) => {
      await page.goto("/");
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      const composer = page.getByRole("main").getByRole("textbox", { name: "Describe what you want to build" });
      await composer.fill(prompt);
      await composer.press("Enter");
    };
    const opened = async (page: Page) => {
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`), { timeout: 30_000 });
    };

    try {
      // A detailed prompt builds straight away.
      await submit(DETAILED_PROMPT);
      await opened(page);
      expect(prompts).toEqual([DETAILED_PROMPT]);

      // Esc counts as Skip: the prompt goes as typed and nothing is saved.
      await submit("a habit tracker");
      await expect(questions).toBeVisible();
      await page.keyboard.press("Escape");
      await opened(page);
      expect(prompts[1]).toBe("a habit tracker");
      expect((await user.query(api.projects.getById, { id: projectId })).instructions).toBeUndefined();

      // Skip does the same in one click.
      await submit("a CRM");
      await questions.getByRole("button", { name: "Skip, just build" }).click();
      await opened(page);
      expect(prompts[2]).toBe("a CRM");

      // The chips fit 375px and work from the keyboard.
      await submit("a habit tracker");
      await expect(questions).toBeVisible();
      const box = (await questions.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      const team = questions.getByRole("radio", { name: "A small team" });
      await team.focus();
      await page.keyboard.press("Space");
      await expect(team).toHaveAttribute("aria-checked", "true");
      await expect(questions.getByRole("radio", { name: "Anyone online" })).toBeInViewport();
      await questions.getByRole("radio", { name: "Minimal" }).click();
      await questions.getByRole("button", { name: "Build with these answers" }).click();
      await opened(page);
      expect(prompts[3]).toBe("a habit tracker\n\nDecisions from setup:\n- Audience: A small team\n- Style: Minimal");
      await expect
        .poll(async () => (await user.query(api.projects.getById, { id: projectId })).instructions)
        .toBe("## Decisions from setup\n- Audience: A small team\n- Style: Minimal");
      // The WebContainer preview iframe serves the generated app, not ours.
      expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
    } finally {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
  });
});
