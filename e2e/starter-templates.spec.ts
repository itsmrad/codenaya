import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PENDING_TEMPLATE_KEY = "codenaya:pendingTemplate";
const TEMPLATE_CARD = /^Use the .+ template$/;

test.describe("starter templates on /showcase (signed out)", () => {
  for (const width of [375, 768, 1440]) {
    test(`shows the six templates without page overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors = collectConsoleErrors(page);
      await page.goto("/showcase");

      const section = page.getByRole("region", { name: "Templates" });
      await expect(section.getByRole("button", { name: TEMPLATE_CARD })).toHaveCount(6);
      await expect(section.getByRole("button", { name: "Use the Landing page template" })).toBeEnabled();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test("picking a template sends the visitor to sign up and keeps the pick", async ({ page }) => {
    await page.goto("/showcase");

    await page.getByRole("button", { name: "Use the Blog template" }).click();

    await expect(page).toHaveURL(/\/sign-up/);
    expect(await page.evaluate((key) => localStorage.getItem(key), PENDING_TEMPLATE_KEY)).toBe(
      "blog",
    );
  });
});

test.describe("starter templates on the dashboard", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("a template creates a project that opens in the IDE with its files", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/");
    const errors = collectConsoleErrors(page);

    const section = page.getByRole("region", { name: "Start from a template" });
    await expect(section.getByRole("button", { name: TEMPLATE_CARD })).toHaveCount(6);

    await section.getByRole("button", { name: "Use the Landing page template" }).click();

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split("/").pop() as Id<"projects">;
    try {
      await expect(page.getByRole("button", { name: "package.json" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("button", { name: "src", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      // Don't pile up template projects (and their agent runs) across runs.
      await (await userConvexClient(page)).mutation(api.projects.remove, { id: projectId });
    }
  });

  test("a template picked before signing up is created on the dashboard", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.evaluate(
      ([key, id]) => localStorage.setItem(key, id),
      [PENDING_TEMPLATE_KEY, "portfolio"],
    );

    await page.goto("/");

    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/, { timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split("/").pop() as Id<"projects">;
    try {
      await expect(page.getByRole("button", { name: "package.json" })).toBeVisible({
        timeout: 30_000,
      });
      expect(await page.evaluate((key) => localStorage.getItem(key), PENDING_TEMPLATE_KEY)).toBeNull();
    } finally {
      await (await userConvexClient(page)).mutation(api.projects.remove, { id: projectId });
    }
  });
});
