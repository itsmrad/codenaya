import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedPreviewProject, seedViteApp } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-references";

test.describe("E2B preview config references", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY",
  );

  // A tsconfig.json that references a file nobody wrote used to boot into a
  // Vite error overlay; the preview now names the file before booting (#190).
  test("names a config file the project references but doesn't contain", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await seedViteApp(projectId, {
      appSource: "export default function App() {\n  return <h1>Missing config</h1>;\n}\n",
      devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.0.0" },
    });
    await new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!).mutation(
      api.system.createFile,
      {
        internalKey: process.env.CODENAYA_CONVEX_INTERNAL_KEY!,
        projectId,
        name: "tsconfig.json",
        content: JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
      },
    );

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "tsconfig.app.json (referenced by tsconfig.json)" }),
    ).toBeVisible({ timeout: 60_000 });
    await test.info().attach("missing-reference", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
