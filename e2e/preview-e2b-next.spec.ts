import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedNextApp, seedPreviewProject } from "./preview-fixtures";

const app = (text: string) => `import Link from "next/link";
export default function Page() {
  return <main><h1>${text}</h1><Link href="/actions">Server Action form</Link></main>;
}
`;

const BROKEN_IMPORT = `import Missing from "./Missing";
export default function Page() { return <Missing />; }
`;

test.describe("E2B Next.js App Router preview", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
  });

  test("boots an App Router page in the preview iframe", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-next-boot");
    await seedNextApp(projectId, { pageSource: app("Next App Router ready") });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Next App Router ready" })).toBeVisible({
      timeout: 240_000,
    });
    expect(page.frame({ url: /e2b\.app/ })).not.toBeNull();
  });

  test("hot-updates page.tsx without reloading the iframe", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-next-hmr");
    const pageId = await seedNextApp(projectId, { pageSource: app("Before Next edit") });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Before Next edit" })).toBeVisible({
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
      content: app("After Next edit"),
    });
    await expect(preview.getByRole("heading", { name: "After Next edit" })).toBeVisible({
      timeout: 60_000,
    });
    expect(await frame.evaluate(() => (window as { hmrMarker?: boolean }).hmrMarker)).toBe(true);
  });

  test("reports a broken import with a Fix with AI entry", async ({ page }) => {
    test.fixme(true, "Enable after #710 merges: Next terminal error capture backs up the #712 overlay bridge");
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-next-errors");
    const pageId = await seedNextApp(projectId, { pageSource: app("Before Next error") });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Before Next error" })).toBeVisible({
      timeout: 240_000,
    });

    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    await system.mutation(api.system.updateFile, {
      internalKey: process.env.CODENAYA_CONVEX_INTERNAL_KEY!,
      projectId,
      fileId: pageId,
      content: BROKEN_IMPORT,
    });
    const banner = page.getByRole("alert").filter({ hasText: "Fix with AI" });
    await expect(banner).toContainText("Module not found", { timeout: 60_000 });
    await expect(banner).toContainText("Missing");
    await expect(banner).toContainText("src/app/page.tsx");
    await expect(banner).toHaveCount(1);

    // Stub the fix request so this spec never starts an agent run.
    const sent: string[] = [];
    await page.route("**/api/messages", async (route) => {
      sent.push((route.request().postDataJSON() as { message: string }).message);
      await route.fulfill({ status: 200, json: {} });
    });
    await banner.getByRole("button", { name: "Fix with AI" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toContain("Module not found");
    expect(sent[0]).toContain("Missing");
  });

  test("submits a Server Action through the preview proxy", async ({ page }) => {
    const projectId = await seedPreviewProject(page, "e2e-preview-e2b-next-actions");
    await seedNextApp(projectId, { pageSource: app("Next actions ready") });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Next actions ready" })).toBeVisible({
      timeout: 240_000,
    });
    await preview.getByRole("link", { name: "Server Action form" }).click();
    await expect(preview.getByRole("status")).toHaveText("No submission yet", { timeout: 60_000 });
    await preview.getByRole("textbox", { name: "Message" }).fill("Through the proxy");
    const submitted = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.hostname.endsWith(".e2b.app") && url.pathname === "/actions" &&
        response.request().method() === "POST";
    }, { timeout: 60_000 });
    await preview.getByRole("button", { name: "Submit message" }).click();
    expect((await submitted).status()).toBeLessThan(400);
    await expect(preview.getByRole("status")).toHaveText("Submitted: Through the proxy", {
      timeout: 60_000,
    });
  });
});
