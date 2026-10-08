import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject, seedViteApp } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-hmr";

const app = (text: string) =>
  `export default function App() {\n  return <h1>${text}</h1>;\n}\n`;

test.describe("E2B preview hot reload", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  test("an edit hot-updates the preview within 3s, without a reload or websocket errors", async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    // Vite 6, which also runs on the E2B base image's Node 20.9 (#178).
    const appId = await seedViteApp(projectId, {
      appSource: app("Before edit"),
      devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.0.0" },
    });
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Before edit" })).toBeVisible({
      timeout: 240_000,
    });
    // Let the post-boot file sync settle, then mark the page so a reload would show.
    await page.waitForTimeout(5_000);
    const frame = page.frame({ url: /e2b\.app/ })!;
    await frame.evaluate(() => ((window as { hmrMarker?: boolean }).hmrMarker = true));

    // The agent writes files through this same mutation. Returns how long the
    // edit took to show up in the preview.
    const editAndWait = async (text: string) => {
      const startedAt = Date.now();
      await system.mutation(api.system.updateFile, {
        internalKey,
        projectId,
        fileId: appId,
        content: app(text),
      });
      // Without #146 the edit never arrives at all, so a generous wait still
      // catches that; the latency budget is asserted separately below.
      await expect(preview.getByRole("heading", { name: text })).toBeVisible({
        timeout: 60_000,
      });
      return Date.now() - startedAt;
    };

    // The first edit also pays for `next dev` compiling the PATCH route.
    const firstEditMs = await editAndWait("After edit");
    const editMs = await editAndWait("Second edit");
    await page.screenshot({ path: testInfo.outputPath("after-edit.png") });
    testInfo.annotations.push({
      type: "edit-to-preview",
      description: `first ${firstEditMs}ms, warm ${editMs}ms`,
    });
    console.log(`[#179] edit→preview: first ${firstEditMs}ms, warm ${editMs}ms`);

    expect(await frame.evaluate(() => (window as { hmrMarker?: boolean }).hmrMarker)).toBe(
      true,
    );
    // Debounce + PATCH round trip to E2B + Vite's hot update (#179).
    expect(editMs).toBeLessThan(3_000);
    expect(errors).toEqual([]);
  });
});
