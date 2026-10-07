import { expect, test } from "@playwright/test";

import { AGENT_MODELS } from "../src/features/conversations/agent-models";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const projectId = process.env.E2E_PROJECT_ID;

test.describe("chat agent model switcher", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  test("lists the allowlist and remembers the picked model", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // In `next dev` the dev-tools badge sits over the composer's bottom-left
    // corner, where the switcher lives, and swallows the click.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    // Scoped to the platform group: the user's own keys add groups of their own.
    const platform = page.getByRole("group", { name: "Codenaya" });
    await expect(platform.getByRole("option")).toHaveCount(AGENT_MODELS.length);
    await platform.getByRole("option", { name: "Claude Sonnet 5.5" }).click();
    await expect(trigger).toHaveText("Claude Sonnet 5.5");

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Agent model" }),
    ).toHaveText("Claude Sonnet 5.5");

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
