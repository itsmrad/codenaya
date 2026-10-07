import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { PENDING_PROMPT_KEY } from "../src/features/projects/utils/pending-prompt";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const SMOKE_PROMPT = "e2e landing smoke: reply OK and change nothing.";

const pendingPrompt = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), PENDING_PROMPT_KEY);

/** Types a prompt into the landing hero and submits it. */
const submitHeroPrompt = async (page: Page, prompt: string) => {
  const composer = page
    .getByRole("textbox", { name: "Describe what you want to build" })
    .first();
  await composer.fill(prompt);
  await composer.press("Enter");
};

test.describe("landing hero prompt", () => {
  test("a signed-out prompt is kept and routes to sign-up on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const errors = collectConsoleErrors(page);
    await page.goto("/");

    await submitHeroPrompt(page, "A recipe app");

    await expect(page).toHaveURL(/\/sign-up/);
    expect(await pendingPrompt(page)).toBe("A recipe app");
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  test("a starter chip fills the hero prompt without leaving the page", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Portfolio" }).first().click();

    await expect(
      page.getByRole("textbox", { name: "Describe what you want to build" }).first(),
    ).toHaveValue(/Portfolio/);
    await expect(page).toHaveURL("/");
  });

  test.describe("after sign-in", () => {
    test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

    test("the dashboard creates the pending project and opens it", async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto("/");
      await submitHeroPrompt(page, SMOKE_PROMPT);
      await expect(page).toHaveURL(/\/sign-up/);

      await signIn(page);
      await page.goto("/");

      await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
      await expect(page.getByText(SMOKE_PROMPT)).toBeVisible({ timeout: 30_000 });
      expect(await pendingPrompt(page)).toBeNull();

      const projectId = page.url().split("/").pop() as Id<"projects">;
      const user = await userConvexClient(page);
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    });
  });
});
