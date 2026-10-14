import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-boot-steps";

/** A boot that has written the files and is installing; the stream then ends without `ready`. */
const INSTALLING = [
  { type: "status", status: "booting" },
  { type: "phase", phase: "create", at: 0 },
  { type: "output", data: "Creating E2B sandbox...\n" },
  { type: "phase", phase: "files", at: 0 },
  { type: "status", status: "installing" },
  { type: "phase", phase: "install", at: 0 },
  { type: "output", data: "$ npm install\n" },
];

test.describe("preview boot steps", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("shows the boot as four steps with elapsed time and a Show logs link", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: INSTALLING.map((event) => JSON.stringify(event)).join("\n") + "\n",
      }),
    );
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    await page.goto(`/projects/${projectId}?view=preview`);

    const boot = page.getByRole("status", { name: "Starting preview" });
    await expect(boot).toBeVisible({ timeout: 60_000 });
    const steps = boot.getByRole("listitem");
    await expect(steps).toHaveText([
      /Create sandbox\s*\(done\)/,
      /Write files\s*\(done\)/,
      /Install dependencies\s*\(in progress\)/,
      /Start dev server/,
    ]);
    await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");
    await expect(steps.nth(3)).toHaveAttribute("data-state", "pending");
    // The elapsed time ticks.
    const elapsed = boot.getByText(/^\d+s$/);
    const first = await elapsed.textContent();
    await expect(elapsed).not.toHaveText(first!, { timeout: 5_000 });

    // The terminal shows by default, so the link only appears once it's hidden.
    await expect(boot.getByRole("button", { name: "Show logs" })).toBeHidden();
    await page.getByRole("button", { name: "Toggle terminal" }).click();
    await expect(page.getByText("$ npm install")).toBeHidden();
    await boot.getByRole("button", { name: "Show logs" }).click();
    await expect(page.getByText("$ npm install")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
