import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PENDING_REMIX_KEY = "codenaya:pendingIntent";

/** A published showcase project to open, or null when the showcase is empty. */
const findPublishedProject = async () => {
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const [project] = await client.query(api.showcase.getTrending, { limit: 1 });
  return project ?? null;
};

/** Deletes the project a Remix just opened, so runs don't pile up copies. */
const removeRemixedProject = async (page: Page) => {
  const projectId = new URL(page.url()).pathname.split("/").pop() as Id<"projects">;
  await (await userConvexClient(page)).mutation(api.projects.remove, { id: projectId });
};

test.describe("public showcase (signed out)", () => {
  for (const width of [375, 768, 1440]) {
    test(`feed opens a shareable detail page at ${width}px`, async ({ page }) => {
      const project = await findPublishedProject();
      test.skip(!project, "no published showcase projects to show");

      await page.setViewportSize({ width, height: 900 });
      const errors = collectConsoleErrors(page);
      await page.goto("/showcase");

      await expect(page.getByRole("heading", { name: "Community showcase" })).toBeVisible();
      // The feed pages newest first; "Top" lists the trending project first.
      await page.getByRole("button", { name: "Top", exact: true }).click();
      const card = page.locator(`a[href="/showcase/${project!._id}"]`);
      await card.click();

      await expect(page).toHaveURL(new RegExp(`/showcase/${project!._id}$`));
      await expect(page.getByRole("heading", { name: project!.title })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Upvote \(\d+\)$/ })).toBeVisible();
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /.+/);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test("Remix sends the visitor to sign-up and keeps the intent", async ({ page }) => {
    const project = await findPublishedProject();
    test.skip(!project, "no published showcase projects to show");

    await page.goto(`/showcase/${project!._id}`);
    await page.getByRole("button", { name: "Remix" }).click();

    await expect(page).toHaveURL(/\/sign-up\?redirect_url=/);
    const intent = await page.evaluate((key) => localStorage.getItem(key), PENDING_REMIX_KEY);
    expect(JSON.parse(intent!)).toEqual({ kind: "remix", showcaseId: project!._id });
  });

  test("an unknown id shows the not-found page", async ({ page }) => {
    await page.goto("/showcase/not-a-real-id");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});

test.describe("showcase Remix (signed in)", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("a Remix started signed out finishes after sign-in", async ({ page }) => {
    const project = await findPublishedProject();
    test.skip(!project, "no published showcase projects to show");

    await page.goto(`/showcase/${project!._id}`);
    await page.getByRole("button", { name: "Remix" }).click();
    await expect(page).toHaveURL(/\/sign-up\?redirect_url=/);
    const returnTo = new URL(page.url()).searchParams.get("redirect_url")!;

    await signIn(page);
    await page.goto(returnTo);

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    await removeRemixedProject(page);
  });

  test("Copy link copies the page URL and Remix opens the copy", async ({ page, context }) => {
    const project = await findPublishedProject();
    test.skip(!project, "no published showcase projects to show");

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page);
    await page.goto(`/showcase/${project!._id}`);

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(new URL(`/showcase/${project!._id}`, page.url()).toString());

    await page.getByRole("button", { name: "Remix" }).click();
    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    await removeRemixedProject(page);
  });
});
