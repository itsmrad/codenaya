import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/** Reuses (or creates) one of the e2e user's fixture projects. */
const fixtureProject = async (page: Page, name: string) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === name,
  );
  return existing?._id ?? (await user.mutation(api.projects.create, { name }));
};

const openSkills = async (page: Page, projectId: Id<"projects">) => {
  await page.goto(`/projects/${projectId}?engine=webcontainer`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skills" });
  await expect(dialog.getByRole("switch", { name: "Enable find-skills" })).toBeVisible();
  return dialog;
};

test.describe("project skills panel", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  test("toggles library skills and creates a project-only skill", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    const skillName = `e2e-skill-${Date.now()}`;

    await signIn(page);
    const projectId = await fixtureProject(page, "e2e-skills-a");
    const otherProjectId = await fixtureProject(page, "e2e-skills-b");

    // Start from a clean slate: everything off in the fixture project.
    const user = await userConvexClient(page);
    await user.mutation(api.skills.setAllProjectSkillsEnabled, {
      projectId,
      enabled: false,
    });

    try {
      await page.setViewportSize({ width: 375, height: 812 });
      let dialog = await openSkills(page, projectId);
      const findSkills = dialog.getByRole("switch", { name: "Enable find-skills" });
      await expect(findSkills).not.toBeChecked();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await findSkills.click();
      await expect(findSkills).toBeChecked();
      await page.reload();
      await page.getByRole("button", { name: "Skills", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "Skills" });
      await expect(
        dialog.getByRole("switch", { name: "Enable find-skills" }),
      ).toBeChecked();

      // Turn it back off so the bulk control offers "Enable all".
      await dialog.getByRole("switch", { name: "Enable find-skills" }).click();
      const library = dialog.getByRole("region", { name: "From your library" });
      await library.getByRole("button", { name: "Enable all" }).click();
      for (const toggle of await library.getByRole("switch").all()) {
        await expect(toggle).toBeChecked();
      }
      await library.getByRole("button", { name: "Disable all" }).click();
      for (const toggle of await library.getByRole("switch").all()) {
        await expect(toggle).not.toBeChecked();
      }

      // Invalid names are flagged as you type; a valid one saves to the project.
      await dialog.getByRole("button", { name: "New skill" }).click();
      const editor = page.getByRole("dialog", { name: "New skill" });
      await editor.getByLabel("Name").fill("Bad--Name");
      await expect(editor.getByRole("alert")).toContainText("lowercase letters");

      await editor.getByLabel("Name").fill(skillName);
      await editor
        .getByLabel("Description")
        .fill("Use when testing the skills panel end to end.");
      await editor.getByLabel("Instructions").fill("# E2E\n\nDo nothing.");
      await expect(editor.getByLabel("This project only")).toBeChecked();
      await editor.getByRole("button", { name: "Create skill" }).click();
      await expect(editor).toBeHidden();

      const thisProject = dialog.getByRole("region", { name: "This project" });
      await expect(thisProject.getByText(skillName)).toBeVisible();
      await expect(
        thisProject.getByRole("switch", { name: `Enable ${skillName}` }),
      ).toBeChecked();

      const other = await openSkills(page, otherProjectId);
      await expect(other.getByText(skillName)).toHaveCount(0);

      dialog = await openSkills(page, projectId);
      await dialog.getByRole("button", { name: `Delete ${skillName}` }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
      await expect(dialog.getByText(skillName)).toHaveCount(0);

      expect(errors).toEqual([]);
    } finally {
      const client = await userConvexClient(page);
      const skills = await client.query(api.skills.listProjectSkills, { projectId });
      for (const skill of skills) {
        if (skill.name === skillName) {
          await client.mutation(api.skills.remove, {
            skillId: skill.key.slice("user:".length) as Id<"skills">,
          });
        }
      }
    }
  });
});
