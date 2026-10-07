import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

// Unique per run, so a skill another run (or a crashed one) left in the
// library can't match the locators below.
const SKILL_NAME = `e2e-imported-skill-${Date.now()}`;
const SOURCE_URL = `https://github.com/vercel-labs/agent-skills/tree/main/skills/${SKILL_NAME}`;

/** Deletes this run's imported skill. */
const removeImported = async (page: Page) => {
  const user = await userConvexClient(page);
  for (const skill of await user.query(api.skills.listLibrary, {})) {
    if (skill.name === SKILL_NAME) {
      await user.mutation(api.skills.remove, { skillId: skill._id });
    }
  }
};

test.describe("import a skill from GitHub", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  test("previews, saves and shows the GitHub badge", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const errors = collectConsoleErrors(page);

    await signIn(page);

    // No network in CI: the preview comes from a mocked import route.
    await page.route("**/api/skills/import", (route) =>
      route.fulfill({
        json: {
          skill: {
            name: SKILL_NAME,
            description: "Use when testing skill imports.",
            body: "# Imported\n\nFollow these steps.",
            sourceUrl: SOURCE_URL,
          },
        },
      }),
    );

    try {
      await page.goto("/settings/skills");
      await page.getByRole("button", { name: "Import" }).first().click();

      const dialog = page.getByRole("dialog", { name: "Import a skill" });
      await dialog.getByLabel("Skill URL").fill(SOURCE_URL);
      await dialog.getByRole("button", { name: "Preview" }).click();

      await expect(dialog.getByRole("heading", { name: SKILL_NAME })).toBeVisible();
      await expect(dialog.getByText("Use when testing skill imports.")).toBeVisible();
      await expect(dialog.getByRole("link", { name: SOURCE_URL })).toBeVisible();
      await dialog.getByRole("button", { name: "Save to my library" }).click();
      await expect(dialog).toBeHidden();

      const card = page
        .getByRole("list", { name: "Library skills" })
        .getByRole("listitem", { name: SKILL_NAME });
      await expect(card).toBeVisible();
      await expect(card).toContainText("GitHub");

      expect(errors).toEqual([]);
    } finally {
      await removeImported(page);
    }
  });

  test("shows an inline error for a non-GitHub URL", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.goto("/settings/skills");

    await page.getByRole("button", { name: "Import" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Import a skill" });
    await dialog.getByLabel("Skill URL").fill("https://example.com/skill");
    await dialog.getByRole("button", { name: "Preview" }).click();

    await expect(
      dialog.getByText("Only GitHub and skills.sh links can be imported"),
    ).toBeVisible();
    await expect(dialog.getByLabel("Skill URL")).toHaveAttribute("aria-invalid", "true");
  });
});
