import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/** Reuses (or creates) the e2e user's theme fixture project. */
const fixtureProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === "e2e-theme",
  );
  return existing?._id ?? (await user.mutation(api.projects.create, { name: "e2e-theme" }));
};

// Client-side only: saving is covered by convex/projects.test.ts, so this runs
// against a backend that doesn't have `projects.updateTheme` yet.
test.describe("project theme form (#302)", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  test("picks a preset, edits colours and warns on low contrast", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await fixtureProject(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Instructions, design and skills" });

    const ocean = dialog.getByRole("group", { name: "Theme presets" }).getByRole("button", { name: "Ocean" });
    await ocean.click();
    await expect(ocean).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByLabel("Primary", { exact: true })).toHaveValue("#2563eb");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();

    await dialog.getByLabel("Primary", { exact: true }).fill("#787878");
    await expect(dialog.getByRole("status")).toContainText("WCAG AA needs 4.5:1");
    await expect(ocean).toHaveAttribute("aria-pressed", "false");

    await dialog.getByLabel("Primary", { exact: true }).fill("#12");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
});
