import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject, seedViteApp } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-node";

test.describe("E2B preview Node version", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  // Vite 7 needs Node 20.19+: it boots on the Node 22 template (E2B_TEMPLATE)
  // and fails with a clear reason on the base image's Node 20.9 (#178).
  test("a Vite 7 app boots, or says why the sandbox's Node can't run it", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await seedViteApp(projectId, {
      appSource: "export default function App() {\n  return <h1>Vite 7 app</h1>;\n}\n",
      devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^5.0.0" },
    });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    if (process.env.E2B_TEMPLATE) {
      const preview = page.frameLocator('iframe[title="Preview"]');
      await expect(preview.getByRole("heading", { name: "Vite 7 app" })).toBeVisible({
        timeout: 240_000,
      });
      expect(errors).toEqual([]);
    } else {
      await expect(
        page.getByRole("alert").filter({ hasText: "needs Node 20.19+" }),
      ).toBeVisible({ timeout: 120_000 });
    }
  });
});
