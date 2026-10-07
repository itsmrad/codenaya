import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const COPY_NAME = "find-skills-copy";

/** Deletes the duplicated built-in left behind by an earlier run. */
const removeCopy = async (page: Page) => {
  const user = await userConvexClient(page);
  for (const skill of await user.query(api.skills.listLibrary, {})) {
    if (skill.name === COPY_NAME) {
      await user.mutation(api.skills.remove, { skillId: skill._id });
    }
  }
};

test.describe("settings skills tab", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  test("duplicates the built-in, edits and deletes it", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const errors = collectConsoleErrors(page);
    const description = `Edited by e2e at ${Date.now()}.`;

    await signIn(page);
    await removeCopy(page);

    try {
      await page.goto("/settings/skills");
      await expect(
        page.getByRole("heading", { level: 1, name: "Skills" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      // A user with an empty library sees the empty state.
      const user = await userConvexClient(page);
      if ((await user.query(api.skills.listLibrary, {})).length === 0) {
        await expect(page.getByText("No skills in your library yet")).toBeVisible();
      }

      // The built-in opens read-only and duplicates into the library.
      const builtins = page.getByRole("list", { name: "Built-in skills" });
      await builtins.getByRole("button", { name: "View find-skills" }).click();
      const viewer = page.getByRole("dialog", { name: "Built-in skill" });
      await expect(viewer.getByLabel("Name")).toHaveAttribute("readonly", "");
      await viewer.getByRole("button", { name: "Duplicate to my library" }).click();

      const editor = page.getByRole("dialog", { name: "New skill" });
      await expect(editor.getByLabel("Name")).toHaveValue(COPY_NAME);
      await editor.getByRole("button", { name: "Create skill" }).click();
      await expect(editor).toBeHidden();

      const library = page.getByRole("list", { name: "Library skills" });
      const card = library.getByRole("listitem", { name: COPY_NAME });
      await expect(card).toBeVisible();
      await expect(card).toContainText("Not enabled in any project");

      // Edits survive a reload.
      await card.getByRole("button", { name: `Edit ${COPY_NAME}` }).click();
      const edit = page.getByRole("dialog", { name: "Edit skill" });
      await edit.getByLabel("Description").fill(description);
      await edit.getByRole("button", { name: "Save changes" }).click();
      await expect(edit).toBeHidden();
      await page.reload();
      await expect(card).toContainText(description);

      await card.getByRole("button", { name: `Delete ${COPY_NAME}` }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(page.getByRole("listitem", { name: COPY_NAME })).toHaveCount(0);

      expect(errors).toEqual([]);
    } finally {
      await removeCopy(page);
    }
  });
});
