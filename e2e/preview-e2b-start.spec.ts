import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedPreviewProject, seedStartApp } from "./preview-fixtures";

const app = (text: string) => `import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <main><h1>${text}</h1><Link to="/actions">Server function form</Link></main>;
}
`;

const BROKEN_IMPORT = `import { createFileRoute } from "@tanstack/react-router";
import Missing from "./Missing";

export const Route = createFileRoute("/")({ component: () => <Missing /> });
`;

test.describe("E2B TanStack Start preview", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
  });

  test("boots a Start page in the preview iframe", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-start-boot");
    await seedStartApp(projectId, { pageSource: app("Start ready") });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Start ready" })).toBeVisible({
      timeout: 240_000,
    });
    expect(page.frame({ url: /e2b\.app/ })).not.toBeNull();
  });

  test("hot-updates routes/index.tsx without reloading the iframe", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-start-hmr");
    const pageId = await seedStartApp(projectId, { pageSource: app("Before Start edit") });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Before Start edit" })).toBeVisible({
      timeout: 240_000,
    });
    // Let the post-boot sync and automatic preview refresh settle, as in the Vite HMR spec.
    await page.waitForTimeout(5_000);
    const frame = page.frame({ url: /e2b\.app/ })!;
    await frame.evaluate(() => ((window as { hmrMarker?: boolean }).hmrMarker = true));

    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    await system.mutation(api.system.updateFile, {
      internalKey: process.env.CODENAYA_CONVEX_INTERNAL_KEY!,
      projectId,
      fileId: pageId,
      content: app("After Start edit"),
    });
    await expect(preview.getByRole("heading", { name: "After Start edit" })).toBeVisible({
      timeout: 60_000,
    });
    expect(await frame.evaluate(() => (window as { hmrMarker?: boolean }).hmrMarker)).toBe(true);
  });

  test("reports a broken import with a Fix with AI entry", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-start-errors");
    const pageId = await seedStartApp(projectId, { pageSource: app("Before Start error") });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Before Start error" })).toBeVisible({
      timeout: 240_000,
    });

    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    await system.mutation(api.system.updateFile, {
      internalKey: process.env.CODENAYA_CONVEX_INTERNAL_KEY!,
      projectId,
      fileId: pageId,
      content: BROKEN_IMPORT,
    });
    // Compile errors come through vite-error-overlay, which the preview bridge reads.
    const banner = page.getByRole("alert").filter({ hasText: "Fix with AI" });
    await expect(banner).toContainText("Missing", { timeout: 60_000 });
    await expect(banner).toContainText("src/routes/index.tsx");
    await expect(banner).toHaveCount(1);

    // Stub the fix request so this spec never starts an agent run.
    const sent: string[] = [];
    await page.route("**/api/messages", async (route) => {
      sent.push((route.request().postDataJSON() as { message: string }).message);
      await route.fulfill({ status: 200, json: {} });
    });
    await banner.getByRole("button", { name: "Fix with AI" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toContain("Missing");
  });

  test("calls a createServerFn POST through the preview proxy", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-start-actions");
    await seedStartApp(projectId, { pageSource: app("Start actions ready") });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Start actions ready" })).toBeVisible({
      timeout: 240_000,
    });
    await preview.getByRole("link", { name: "Server function form" }).click();
    await expect(preview.getByRole("status")).toHaveText("No submission yet", { timeout: 60_000 });
    await preview.getByRole("textbox", { name: "Message" }).fill("Through the proxy");
    // Start's CSRF check needs a same-origin Origin, which the proxy rewrites.
    const submitted = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.hostname.endsWith(".e2b.app") && url.pathname.startsWith("/_serverFn/") &&
        response.request().method() === "POST";
    }, { timeout: 60_000 });
    await preview.getByRole("button", { name: "Submit message" }).click();
    expect((await submitted).status()).toBeLessThan(400);
    await expect(preview.getByRole("status")).toHaveText("Submitted: Through the proxy", {
      timeout: 60_000,
    });
  });
});
