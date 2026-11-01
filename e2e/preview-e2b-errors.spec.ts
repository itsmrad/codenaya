import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedPreviewProject, seedViteApp } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-errors";

const BROKEN_IMPORT =
  "import Missing from './Missing.jsx';\n\nexport default function App() {\n  return <Missing />;\n}\n";
const WORKING = "export default function App() {\n  return <h1>Fixed</h1>;\n}\n";
const THROWS =
  "export default function App() {\n  throw new Error('Render exploded');\n}\n";

test.describe("E2B preview error banner (#223)", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  test("shows build and runtime errors and sends one fix message", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    const appId = await seedViteApp(projectId, {
      appSource: BROKEN_IMPORT,
      devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.0.0" },
    });
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const writeApp = (content: string) =>
      system.mutation(api.system.updateFile, { internalKey, projectId, fileId: appId, content });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    // The compile error, read from the dev server's output.
    const banner = page.getByRole("alert").filter({ hasText: "Fix with AI" });
    await expect(banner).toContainText("Build error", { timeout: 240_000 });
    await expect(banner).toContainText("Failed to resolve import");
    await expect(banner).toContainText("src/App.jsx");
    await expect(banner).toHaveCount(1);

    // Widths and themes are covered by preview-errors.spec.ts, which costs no sandbox.
    await page.screenshot({ path: testInfo.outputPath("build-error-banner.png") });

    // One click sends one chat message with the error and the log tail. The
    // route is stubbed so no agent run (or model spend) starts.
    const sent: string[] = [];
    await page.route("**/api/messages", async (route) => {
      sent.push((route.request().postDataJSON() as { message: string }).message);
      await route.fulfill({ status: 200, json: {} });
    });
    await banner.getByRole("button", { name: "Fix with AI" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toContain("Failed to resolve import");
    expect(sent[0]).toContain("Last terminal lines:");

    // A working edit clears it.
    await writeApp(WORKING);
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Fixed" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("alert").filter({ hasText: "Build error" })).toHaveCount(0);

    // A render error, reported by the injected bridge.
    await writeApp(THROWS);
    const runtime = page.getByRole("alert").filter({ hasText: "Runtime error" });
    await expect(runtime).toContainText("Render exploded", { timeout: 60_000 });
    await expect(runtime).toHaveCount(1);
  });
});
