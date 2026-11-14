import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { PENDING_PROMPT_KEY } from "../src/features/projects/utils/pending-prompt";
import { PENDING_TEMPLATE_KEY } from "../src/features/templates/utils/pending-template";
import { hasClerkCredentials, signIn } from "./clerk-auth";

const PROMPT = 'A <b>recipe app</b> with weekly meal plans';
const composer = (page: Page) => page.getByRole("textbox", { name: "Describe what you want to build" }).first();

test.describe("onboarding handoff", () => {
  test.skip(!hasClerkCredentials(), "needs Clerk DEV credentials");

  test("keeps the dashboard hidden until navigation and restores the prompt on failure", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    await page.evaluate(({ key, prompt }) => localStorage.setItem(key, JSON.stringify({ prompt, savedAt: Date.now() })), { key: PENDING_PROMPT_KEY, prompt: PROMPT });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    // Intercept before the server: this flow must never dispatch a paid run.
    await page.route("**/api/projects/create-with-prompt", async (route) => {
      requests++;
      await held;
      await route.fulfill({ status: 500, json: { error: "Unable to create project" } });
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Starting your build" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(PROMPT);
    await expect(composer(page)).toHaveCount(0);
    await expect(page.locator("main b")).toHaveCount(0);
    release();
    await expect(composer(page)).toHaveValue(PROMPT);
    await expect(page.getByText("Unable to create project", { exact: true })).toBeVisible();
    expect(requests).toBe(1);
    await page.reload();
    await expect(composer(page)).toHaveValue("");
    expect(requests).toBe(1);
  });

  test("expired entries show the dashboard without creating a project", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    await page.evaluate(({ promptKey, templateKey }) => {
      const savedAt = Date.now() - 3_600_001;
      localStorage.setItem(promptKey, JSON.stringify({ prompt: "Expired prompt", savedAt }));
      localStorage.setItem(templateKey, JSON.stringify({ templateId: "portfolio", savedAt }));
    }, { promptKey: PENDING_PROMPT_KEY, templateKey: PENDING_TEMPLATE_KEY });
    const requests: string[] = [];
    await page.route("**/api/projects/create-with-prompt", async (route) => {
      requests.push(route.request().url());
      await route.fulfill({ status: 500, json: {} });
    });
    await page.reload();
    await expect(composer(page)).toBeVisible();
    expect(requests).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), PENDING_PROMPT_KEY)).toBeNull();
  });
});
