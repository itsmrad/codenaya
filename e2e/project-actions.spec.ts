import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/** Opens the dashboard with the grid filtered down to `name`. */
const openDashboard = async (page: Page, name: string) => {
  await page.goto("/");
  await page
    .getByRole("region", { name: "Your projects" })
    .getByRole("searchbox", { name: "Search projects" })
    .fill(name);
};

const cardMenu = (page: Page, name: string) =>
  page.getByRole("button", { name: `Actions for ${name}`, exact: true });

const confirmDelete = async (page: Page) => {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("can't be undone");
  await dialog.getByRole("button", { name: "Delete project" }).click();
};

test.describe("project actions", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  for (const width of [375, 768, 1440]) {
    test(`duplicate, rename and delete at ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      // The dev-tools badge covers the bottom-left tab on phones (see ide-shell.spec.ts).
      await page.addInitScript(() => {
        const style = document.createElement("style");
        style.textContent = "nextjs-portal { display: none !important; }";
        document.addEventListener("DOMContentLoaded", () => document.body.append(style));
      });
      await page.setViewportSize({ width, height: 900 });
      const errors = collectConsoleErrors(page);
      await signIn(page);

      const name = `e2e-actions-${width}-${Date.now()}`;
      const user = await userConvexClient(page);
      const projectId = await user.mutation(api.projects.create, { name });
      await user.mutation(api.files.createFile, {
        projectId,
        name: "index.html",
        content: "<h1>hi</h1>",
      });

      try {
        // Dashboard → Duplicate: a "(copy)" card appears.
        await openDashboard(page, name);
        await cardMenu(page, name).click();
        await page.getByRole("menuitem", { name: "Duplicate" }).click();
        const copyName = `${name} (copy)`;
        await expect(cardMenu(page, copyName)).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);

        // The copy has the same file tree.
        await page.getByRole("link", { name: new RegExp(copyName.replace(/[()]/g, "\\$&")) }).click();
        await page.waitForURL(/\/projects\//);
        const copyUrl = page.url();
        if (width < 768) {
          await page.getByRole("tab", { name: "Code" }).click();
        }
        await expect(page.getByRole("button", { name: "index.html", exact: true })).toBeVisible({
          timeout: 60_000,
        });

        // IDE menu → Rename updates the title.
        const renamed = `${name} renamed`;
        await page.getByRole("button", { name: "Project actions" }).click();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        const input = page.getByRole("textbox", { name: "Project name" });
        await input.fill("   ");
        await input.press("Enter");
        await expect(input).toHaveAttribute("aria-invalid", "true");
        await input.fill(renamed);
        await input.press("Enter");
        await expect(page.getByRole("button", { name: renamed, exact: true })).toBeVisible();

        // IDE menu → Delete → back on the dashboard without it.
        await page.getByRole("button", { name: "Project actions" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await confirmDelete(page);
        await page.waitForURL((url) => url.pathname === "/");

        // Dashboard → Delete the original: gone, also after a reload.
        await openDashboard(page, name);
        await expect(cardMenu(page, renamed)).toHaveCount(0);
        await cardMenu(page, name).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await confirmDelete(page);
        await expect(cardMenu(page, name)).toHaveCount(0);
        await page.reload();
        await openDashboard(page, name);
        await expect(page.getByText(`No projects match “${name}”`)).toBeVisible();

        // Its URL shows the not-found view.
        await page.goto(copyUrl);
        await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible({
          timeout: 30_000,
        });
      } finally {
        await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
      }

      // The not-found view logs the refused Convex query; nothing else may error.
      expect(errors.filter((error) => !/Project not found/.test(error))).toEqual([]);
    });
  }
});
