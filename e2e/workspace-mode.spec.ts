import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signInAsSpecUser } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-workspace-mode";

// #524: Chat-first shows the chat and the preview only, on every project.
test.describe("workspace mode", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("Chat-first opens a project without the code, until opened for the visit", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // A ready preview without E2B, as in ide-session.spec.ts.
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
      }),
    );
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));

    // A user of its own: the mode is account-wide and would change other specs' layout.
    await signInAsSpecUser(page, "workspace-mode");
    await page.goto("/settings/workspace");
    const chatFirst = page.getByRole("radio", { name: /Chat-first/ });
    await expect(chatFirst).toBeEnabled();
    await chatFirst.click();
    await expect(chatFirst).toBeChecked();
    // The radio shows the optimistic value at once; wait until it is saved.
    const user = await userConvexClient(page);
    await expect.poll(() => user.query(api.userPreferences.getWorkspaceMode, {})).toBe("chat");

    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.goto(`/projects/${projectId}`);
    const openCode = page.getByRole("button", { name: "Open code for this session" });
    await expect(openCode).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Code" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /index\.html/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();

    // Opening the code is for this visit only; the setting stays Chat-first.
    await openCode.click();
    await expect(page.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(openCode).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Code" })).toHaveCount(0);
  });
});
