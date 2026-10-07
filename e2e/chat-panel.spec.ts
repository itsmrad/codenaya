import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const projectId = process.env.E2E_PROJECT_ID;

test.describe("chat panel", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  test("renders the empty state and sends a message", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();
    await expect(page.getByRole("button", { name: /landing page/ })).toBeVisible();

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();

    const prompt = `e2e chat smoke ${Date.now()}: reply OK, change nothing.`;
    await input.fill(prompt);
    await expect(send).toBeEnabled();
    await input.press("Enter");

    // The user bubble lands and the composer clears.
    await expect(page.getByText(prompt)).toBeVisible();
    await expect(input).toHaveValue("");

    // While the agent runs, the send button turns into Stop. Stopping is
    // best-effort cleanup: cancelling needs the Inngest server, which a local
    // run may not have.
    const stop = page.getByRole("button", { name: "Stop" });
    if (await stop.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      await stop.click();
    }

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
