import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, killProjectSandboxes, seedPreviewProject, seedViteApp } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-node";

test.describe("E2B preview Node version", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  /** The current test's project, whose preview sandbox afterEach frees. */
  let seeded: string | undefined;
  test.afterEach(async ({ page }) => {
    // Closed first, so the preview can't boot a replacement for the killed sandbox.
    await page.close();
    if (seeded) await killProjectSandboxes(seeded);
    seeded = undefined;
  });

  // Vite 7 boots on the Node 22 template, including the default codenaya-node22 (#178).
  test("a Vite 7 app boots on the configured or default Node 22 template", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    seeded = projectId;
    await seedViteApp(projectId, {
      appSource: "export default function App() {\n  return <h1>Vite 7 app</h1>;\n}\n",
      devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^5.0.0" },
    });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Vite 7 app" })).toBeVisible({
      timeout: 240_000,
    });
    expect(errors).toEqual([]);
  });
});
