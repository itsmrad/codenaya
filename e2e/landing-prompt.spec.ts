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
  test("a signed-out prompt is kept and routes to sign-in on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const errors = collectConsoleErrors(page);
    await page.goto("/");

    await submitHeroPrompt(page, "A recipe app");

    await expect(page).toHaveURL(/\/sign-in/);
    expect(await pendingPrompt(page)).toBe("A recipe app");
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  // #252: the auth pages show what will start, without consuming it.
  test("the auth pages show the pending prompt as text and leave it for the dashboard", async ({ page }) => {
    const prompt = 'A <script>alert("x")</script> recipe app';
    await page.goto("/");
    await submitHeroPrompt(page, prompt);
    await expect(page).toHaveURL(/\/sign-in/);

    const note = page.getByRole("status").filter({ hasText: "Your prompt will start building right after you log in" });
    await expect(note).toBeVisible();
    await expect(note).toContainText(prompt);
    expect(await pendingPrompt(page)).toBe(prompt);

    await page.goto("/sign-up");
    await expect(page.getByRole("status").filter({ hasText: "right after sign-up" })).toBeVisible();
  });

  test("the auth pages show no prompt block without a pending prompt", async ({ page }) => {
    await page.goto("/sign-in");
    await page.evaluate((key) => localStorage.removeItem(key), PENDING_PROMPT_KEY);
    await page.reload();
    await expect(page.getByText("Your prompt will start building")).toHaveCount(0);
  });

  test("a model picked signed out is kept with the prompt", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");

    await page.getByRole("button", { name: /^Model:/ }).first().click();
    await page.getByRole("listbox", { name: "Model" }).getByRole("option").last().click();
    // useAgentModel's storage key: the dashboard reads the pick from here after sign-in.
    const stored = () => page.evaluate(() => localStorage.getItem("codenaya:agent-model"));
    const picked = await stored();
    expect(JSON.parse(picked ?? "null")).toEqual({ modelId: expect.any(String) });

    await submitHeroPrompt(page, "A recipe app");

    await expect(page).toHaveURL(/\/sign-in/);
    expect(await pendingPrompt(page)).toBe("A recipe app");
    expect(await stored()).toBe(picked);
    expect(errors).toEqual([]);
  });

  test.describe("after sign-in", () => {
    test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

    test("the dashboard creates the pending project and opens it", async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto("/");
      await submitHeroPrompt(page, SMOKE_PROMPT);
      await expect(page).toHaveURL(/\/sign-in/);

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
