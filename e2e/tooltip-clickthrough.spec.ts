import { expect, test } from "@playwright/test";

import { EMPTY_CHAT_TITLE } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";

const projectId = process.env.E2E_PROJECT_ID;

test.describe("composer tooltips", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  test("the model tooltip does not block the controls it covers", async ({ page }) => {
    test.setTimeout(120_000);
    // The default chat panel is narrow enough that the toolbar wraps, so the
    // model picker's tooltip opens over the row above it (#606).
    await page.setViewportSize({ width: 1280, height: 720 });
    await signIn(page);
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText(EMPTY_CHAT_TITLE)).toBeVisible();

    // Filled first: the fill's focus would otherwise close the tooltip below.
    await page.getByPlaceholder("Describe a change or ask a question…").fill("tooltip check");
    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();

    // `click()` retries until the tooltip closes, which would pass either way. So hit the point
    // the tooltip covers directly, with no retry: first assert what is under it, then click it.
    const swarm = page.getByRole("radiogroup", { name: "Message mode" }).getByRole("radio", { name: "Swarm" });
    const box = (await swarm.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    const tooltip = (await page.locator('[data-slot="tooltip-content"]').boundingBox())!;
    // Guards the premise: the tooltip's box really is over the radio, so this can fail.
    expect(x >= tooltip.x && x <= tooltip.x + tooltip.width).toBe(true);
    expect(y >= tooltip.y && y <= tooltip.y + tooltip.height).toBe(true);
    expect(await swarm.evaluate((el, [px, py]) => el.contains(document.elementFromPoint(px, py)), [x, y])).toBe(true);
    await page.mouse.click(x, y);
    await expect(swarm).toBeChecked();
  });
});
