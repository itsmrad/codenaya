import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { cleanupProject, userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-share-link";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

/** The e2e user's fixture project with one known file, and no share link. */
const seedProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find((p) => p.name === PROJECT_NAME);
  const projectId = existing?._id ?? (await user.mutation(api.projects.create, { name: PROJECT_NAME }));
  await user.mutation(api.projects.revokeShareLink, { projectId });

  const system = new ConvexHttpClient(convexUrl!);
  await cleanupProject(system, internalKey!, projectId);
  await system.mutation(api.system.createFile, {
    internalKey: internalKey!,
    projectId,
    name: "README.md",
    content: "# Shared read-only",
  });
  return projectId;
};

test.describe("read-only share link (#260)", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("owner creates a link, a signed-out visitor views it, revoke makes it 404", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const projectId = await seedProject(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Anyone with the link can view" });
    await toggle.click();
    const linkInput = page.getByRole("textbox", { name: "Share link" });
    await expect(linkInput).toHaveValue(/\/s\/[0-9a-f]{32}$/);
    const link = await linkInput.inputValue();

    const visitor = await browser.newContext();
    try {
      const viewer = await visitor.newPage();
      await viewer.goto(link);
      await expect(viewer.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
      await expect(viewer.getByText(/Shared by .+ · read-only/).first()).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Remix" })).toBeVisible();
      await viewer.getByRole("button", { name: "README.md" }).click();
      await expect(viewer.getByText("# Shared read-only")).toBeVisible();

      await toggle.click();
      await expect(linkInput).toBeHidden();

      await viewer.reload();
      await expect(viewer.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    } finally {
      await visitor.close();
    }
  });
});
