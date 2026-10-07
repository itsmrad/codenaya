import { expect, test, type Locator, type Page } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const ORIGINAL = "todo app";
const ENHANCED =
  "A todo app for individuals to track daily tasks.\n\nPages:\n- Tasks: the list of todos\n\nFeatures:\n- Add, edit and delete tasks\n\nStyle: Clean and minimal\n\nData: Tasks stored per user";

/**
 * Stubs the enhance route so the spec needs no OpenRouter key. The reply is
 * held until `release()` so the loading state can be asserted.
 */
const mockEnhance = async (page: Page) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/enhance-prompt", async (route) => {
    await released;
    await route.fulfill({ json: { prompt: ENHANCED } });
  });
  return release;
};

/** Empty → disabled; type → enhance → loading → spec; Undo → original. */
const expectEnhanceAndUndo = async (
  page: Page,
  scope: Locator,
  input: Locator,
) => {
  const release = await mockEnhance(page);
  const enhance = scope.getByRole("button", { name: "Enhance prompt" });

  await input.fill("");
  await expect(enhance).toBeDisabled();

  await input.fill(ORIGINAL);
  await expect(enhance).toBeEnabled();
  await enhance.click();

  await expect(enhance).toHaveAttribute("aria-busy", "true");
  await expect(enhance).toBeDisabled();
  await expect(input).toBeDisabled();
  release();

  await expect(input).toHaveValue(ENHANCED);
  await expect(input).toBeEnabled();

  await scope.getByRole("button", { name: "Undo enhance" }).click();
  await expect(input).toHaveValue(ORIGINAL);
  await expect(enhance).toBeVisible();
};

test("signed-out POST /api/enhance-prompt returns 401 JSON", async ({ request }) => {
  const response = await request.post("/api/enhance-prompt", {
    data: { prompt: ORIGINAL },
  });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test.describe("enhance prompt", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("dashboard composer enhances and undoes", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await signIn(page);
    await page.goto("/");
    // The dev-tools badge covers the bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

    const main = page.getByRole("main");
    const input = main.getByRole("textbox", { name: "Describe what you want to build" });
    await expect(input).toBeVisible();

    await expectEnhanceAndUndo(page, main, input);
    expect(errors).toEqual([]);
  });

  test("chat composer enhances and undoes", async ({ page }) => {
    const projectId = process.env.E2E_PROJECT_ID;
    test.skip(!projectId, "needs E2E_PROJECT_ID (a project owned by the e2e user)");
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await expect(input).toBeVisible({ timeout: 60_000 });
    test.skip(await input.isDisabled(), "the fixture project's agent is still running");

    await expectEnhanceAndUndo(page, page.locator(".chat-composer"), input);
    expect(errors).toEqual([]);
  });
});
