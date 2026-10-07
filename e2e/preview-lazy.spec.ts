import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-preview-boot";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

/** Reuses (or creates) the e2e user's fixture project; the preview needs a file to boot. */
const seedProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === PROJECT_NAME,
  );
  const projectId =
    existing?._id ?? (await user.mutation(api.projects.create, { name: PROJECT_NAME }));

  const system = new ConvexHttpClient(convexUrl!);
  await system.mutation(api.system.cleanup, { internalKey: internalKey!, projectId });
  await system.mutation(api.system.createFile, {
    internalKey: internalKey!,
    projectId,
    name: "index.html",
    content: "<h1>Hello</h1>\n",
  });

  return projectId;
};

/** The browser logs the stubbed 503 itself; that line is the scenario, not a bug. */
const STUBBED_503 = /status of 503 .*\/api\/sandbox/;

test.describe("preview boot", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("waits for the Preview tab and shows E2B config errors without reloading", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);
    let sandboxRequests = 0;
    await page.route("**/api/sandbox", (route) => {
      sandboxRequests += 1;
      return route.fulfill({
        status: 503,
        json: { error: "E2B_API_KEY is not configured on the Codenaya server.", code: "config" },
      });
    });

    await signIn(page);
    const projectId = await seedProject(page);

    await page.goto(`/projects/${projectId}`);
    // Once the file tree shows, the files have loaded; the old code booted the sandbox then.
    await expect(page.getByRole("button", { name: "index.html", exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);
    expect(sandboxRequests).toBe(0);

    await page.getByRole("tab", { name: "Preview" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Cloud sandbox isn't available" });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(alert).toContainText("E2B_API_KEY is not configured");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(alert.getByRole("button", { name: "Use in-browser preview" })).toBeVisible();

    // No silent fallback: the page stays put and the sandbox isn't retried. (Dev
    // Strict Mode mounts twice, so the first boot can be one aborted request plus one.)
    const bootRequests = sandboxRequests;
    expect(bootRequests).toBeLessThanOrEqual(2);
    await page.waitForTimeout(3_000);
    expect(new URL(page.url()).searchParams.has("engine")).toBe(false);
    expect(sandboxRequests).toBe(bootRequests);

    // Switching tabs keeps the preview mounted instead of booting it again.
    await page.getByRole("tab", { name: "Code" }).click();
    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(alert).toBeVisible();
    expect(sandboxRequests).toBe(bootRequests);

    expect(errors.filter((error) => !STUBBED_503.test(error))).toEqual([]);
  });
});
