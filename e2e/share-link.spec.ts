import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { cleanupProject, userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-share-link";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

/** The e2e user's fixture project with a minimal production Vite site, and no share link. */
const seedProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find((p) => p.name === PROJECT_NAME);
  const projectId = existing?._id ?? (await user.mutation(api.projects.create, { name: PROJECT_NAME }));
  await user.mutation(api.projects.revokeShareLink, { projectId });

  const system = new ConvexHttpClient(convexUrl!);
  await cleanupProject(system, internalKey!, projectId);
  for (const [name, content] of Object.entries({
    "package.json": JSON.stringify({ name: "public-preview-test", version: "1.0.0", type: "module", dependencies: { vite: "^8.0.0" } }),
    "vite.config.js": "export default {}",
    "index.html": "<!doctype html><html><body><h1>Shared website fixture</h1></body></html>",
  })) await system.mutation(api.system.createFile, { internalKey: internalKey!, projectId, name, content });
  return projectId;
};

/** The responsive header keeps Share in the project menu on narrow screens. */
const openShare = async (page: Page) => {
  const more = page.getByRole("button", { name: "More actions", exact: true });
  const menu = page.getByRole("dialog", { name: "Project menu", exact: true });
  if (await more.isVisible() && !await menu.isVisible()) await more.click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
};

test.describe("website-only share link", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("owner creates a link, a signed-out visitor views it, revoke makes it 404", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const projectId = await seedProject(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await openShare(page);
    const toggle = page.getByRole("switch", { name: "Anyone with the link can view" });
    await toggle.click();
    const linkInput = page.getByRole("textbox", { name: "Share link" });
    await expect(linkInput).toHaveValue(/\/preview\/[0-9a-f]{32}$/);
    const link = await linkInput.inputValue();

    const visitor = await browser.newContext();
    try {
      const viewer = await visitor.newPage();
      await viewer.goto(link);
      await expect(viewer.getByText("Made with Codenaya")).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Remix", exact: true })).toBeVisible();
      await expect(viewer.getByRole("navigation", { name: "Files" })).toHaveCount(0);
      await expect(viewer.getByText(/Shared by/)).toHaveCount(0);
      await expect(viewer.frameLocator(`iframe[title="${PROJECT_NAME}"]`).getByRole("heading", { name: "Shared website fixture" })).toBeVisible({ timeout: 150_000 });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.keyboard.press("Escape");
        await openShare(page);
        await expect(page.getByLabel("What to share")).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`share-popover-${width}.png`) });
        await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await viewer.screenshot({ path: test.info().outputPath(`public-preview-${width}.png`) });
      }
      // Legacy links use an HTTP redirect, even before the React shell streams.
      const legacy = await viewer.request.get(link.replace("/preview/", "/s/"), { maxRedirects: 0 });
      expect(legacy.status()).toBe(308);
      expect(legacy.headers().location).toBe(link);
      await viewer.goto(link.replace("/preview/", "/s/"));
      await expect(viewer).toHaveURL(link);
      await expect(viewer.getByRole("button", { name: "Remix", exact: true })).toBeVisible();

      await toggle.click();
      await expect(linkInput).toBeHidden();

      const revoked = await viewer.reload();
      expect(revoked?.status()).toBe(404);
      await expect(viewer.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    } finally {
      await visitor.close();
    }
  });
});
