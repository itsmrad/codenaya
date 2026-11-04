import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-ide-session";

// #315: a project reopens where the user left it.
test.describe("IDE session", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("reopens on the last view with the same tabs after a reload", async ({ page }) => {
    test.setTimeout(120_000);
    // A ready preview without E2B, as in preview-terminal.spec.ts.
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
      }),
    );
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.goto(`/projects/${projectId}`);
    await page.evaluate((id) => localStorage.removeItem(`codenaya:ide:${id}`), projectId);
    await page.reload();

    const workspace = page.getByRole("tablist", { name: "Workspace views" });
    await workspace.getByRole("tab", { name: "Code" }).click();
    await page.getByRole("button", { name: /index\.html/ }).first().dblclick();
    const openFiles = page.getByRole("navigation", { name: "Open files" });
    await expect(openFiles).toContainText("index.html");
    await workspace.getByRole("tab", { name: "Preview" }).click();

    await page.reload();
    await expect(workspace.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true", {
      timeout: 60_000,
    });
    await workspace.getByRole("tab", { name: "Code" }).click();
    await expect(openFiles).toContainText("index.html");
  });
});
