import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const projectId = process.env.E2E_PROJECT_ID;

/**
 * Needs a dev server whose agent backend is unreachable, e.g. started with
 * `INNGEST_BASE_URL=http://127.0.0.1:59999 INNGEST_EVENT_API_BASE_URL=http://127.0.0.1:59999`,
 * so every dispatch fails the way it does when the Inngest server is down.
 */
const dispatchUnreachable = process.env.E2E_DISPATCH_UNREACHABLE === "1";

test.describe("chat when the agent cannot be dispatched", () => {
  test.skip(
    !hasClerkCredentials() || !projectId || !dispatchUnreachable,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, E2E_PROJECT_ID and E2E_DISPATCH_UNREACHABLE=1 (see above)",
  );

  test("marks the reply failed, re-enables the composer and retries", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    // Stop any run left over from an earlier attempt; Stop must work with the
    // backend down too.
    const stop = await page.request.post("/api/messages/cancel", { data: { projectId } });
    expect(stop.ok()).toBe(true);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    // A conversation of its own, so other specs on this project can't interfere.
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();

    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    const failedReplies = page.getByText(/agent service is unreachable/);

    await composer.fill(`Dispatch failure check ${Date.now()}`);
    await composer.press("Enter");

    // Dispatch retries for a few seconds before giving up.
    await expect(
      page.getByText("The agent service is unavailable. Please try again."),
    ).toBeVisible({ timeout: 30_000 });
    await expect(failedReplies).toHaveCount(1);
    await expect(composer).toBeEnabled();

    // The failure is stored, not just shown: a reload shows it instead of a spinner.
    await page.reload();
    await expect(failedReplies).toHaveCount(1);
    await expect(page.locator('[data-run-status="running"]')).toHaveCount(0);
    await expect(composer).toBeEnabled();

    await page.getByRole("button", { name: "Retry" }).last().click();
    await expect(failedReplies).toHaveCount(2, { timeout: 30_000 });

    // The 502s from /api/messages are the failure under test; the WebContainer
    // preview iframe serves the generated app, not ours.
    expect(
      errors.filter(
        (error) => !error.includes("/api/messages") && !error.includes("webcontainer-api.io"),
      ),
    ).toEqual([]);
  });
});
