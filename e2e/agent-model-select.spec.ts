import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { envCatalog, platformProviderId } from "../src/features/ai-providers/platform";
import { platformModels } from "../src/features/ai-providers/hooks/use-ai-providers";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const projectId = process.env.E2E_PROJECT_ID;

test.describe("chat agent model switcher", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  test("lists the allowlist and remembers the picked model", async ({ page }) => {
    test.setTimeout(180_000);
    // The desktop size from #217, where the default panel truncated the name.
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = collectConsoleErrors(page);

    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // In `next dev` the dev-tools badge sits over the composer's bottom-left
    // corner, where the switcher lives, and swallows the click.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    // The full model name fits at the default panel width (#217).
    const name = trigger.locator('[data-slot="select-value"]');
    await expect(name).not.toBeEmpty();
    // Measure the name's own span: it clips itself, so the value wrapper never overflows (#668).
    // The measurement rides in the message so a red run says what overflowed (#606).
    const fit = await name.locator(".truncate").evaluate((el) => ({
      text: el.textContent,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      panelWidth: el.closest(".chat-composer")?.clientWidth,
    }));
    expect(fit.scrollWidth, JSON.stringify(fit)).toBeLessThanOrEqual(fit.clientWidth);
    // Focus shows the full name too, for panels narrow enough to truncate it.
    await trigger.focus();
    await expect(page.getByRole("tooltip")).toContainText((await name.textContent())!);
    await trigger.click();
    // Scoped to the platform group: the user's own keys add groups of their own.
    const platform = page.getByRole("group", { name: "Codenaya" });
    // The picker's own list: the saved catalog (plus Auto), else the env's curated one. It grows
    // with the catalog, so the count is derived, not hard-coded (#606).
    const catalog = await (await userConvexClient(page)).query(api.platformCatalog.getForUsers, {});
    const expected = platformModels(catalog ?? envCatalog(platformProviderId())).models.length;
    await expect(platform.getByRole("option")).toHaveCount(expected);
    // The vendor is a muted tag beside the name, not part of the option text.
    const sonnet = platform.getByRole("option", { name: "Claude Sonnet 5.5" });
    await expect(sonnet).toHaveAttribute("data-tag", /^Anthropic( · ~\d+ cr)?$/);
    await sonnet.click();
    await expect(trigger).toHaveText("Claude Sonnet 5.5");

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Agent model" }),
    ).toHaveText("Claude Sonnet 5.5");

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
