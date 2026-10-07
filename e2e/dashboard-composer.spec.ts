import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const SMOKE_PROMPT = "e2e dashboard smoke: reply OK and change nothing.";

test.describe("dashboard prompt composer", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    // The dev-tools badge covers the bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  });

  test("a starter chip fills the composer without sending", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const composer = page.getByRole("main").getByRole("textbox", {
      name: "Describe what you want to build",
    });
    await expect(composer).toBeVisible();

    await page.getByRole("button", { name: "Portfolio" }).click();

    await expect(composer).toHaveValue(/Portfolio/);
    await expect(composer).toBeFocused();
    await expect(page).toHaveURL("/");
    expect(errors).toEqual([]);
  });

  test("a prompt creates a project and opens it with the agent running", async ({ page }) => {
    test.setTimeout(120_000);
    const composer = page.getByRole("main").getByRole("textbox", {
      name: "Describe what you want to build",
    });

    await composer.fill(SMOKE_PROMPT);
    await composer.press("Enter");

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    // The prompt is the first message of the project's conversation.
    await expect(page.getByText(SMOKE_PROMPT)).toBeVisible({ timeout: 30_000 });
  });

  test("Ctrl+J opens the new-project dialog, which creates a project", async ({ page }) => {
    test.setTimeout(120_000);
    const dialog = page.getByRole("dialog", { name: "What do you want to build?" });
    // The shortcut listener is attached once the page hydrates.
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+j");
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass();

    const input = dialog.getByRole("textbox", { name: "Describe what you want to build" });
    await expect(input).toBeFocused();

    await input.fill(SMOKE_PROMPT);
    await dialog.getByRole("button", { name: "Create project" }).click();

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
  });

  test("a user without projects sees the empty state", async ({ page }) => {
    await page.waitForFunction(() => Boolean((window as { Clerk?: { session?: unknown } }).Clerk?.session));
    const client = await userConvexClient(page);
    const projects = await client.query(api.projects.get, {});
    test.skip(projects.length > 0, "the e2e user already has projects");

    await expect(page.getByRole("button", { name: "Import from GitHub" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Portfolio" })).toBeVisible();
    await expect(page.getByText("No projects yet")).toHaveCount(0);
  });
});
