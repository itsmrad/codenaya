import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

/**
 * After a run (#256, #341): the latest build reply's follow-up chips fill the
 * composer, and the reply that ended the first build offers publish and
 * export once. The replies are seeded, so no run is needed.
 */

const PROJECT_NAME = "e2e-chat-ship-card";
const OLD_CHIP = "Make the header sticky";
const CHIP = "Add a contact form";

test.describe("after a run", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("shows chips under the latest reply and the ship card under the first build", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const conversationId = await (await userConvexClient(page)).mutation(api.conversations.create, {
      projectId,
      title: `Ship card ${Date.now()}`,
    });
    const reply = async (content: string, fields: { suggestions: string[]; firstBuild?: boolean }) => {
      const messageId: Id<"messages"> = await system.mutation(api.system.createMessage, {
        internalKey,
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        status: "processing",
      });
      await system.mutation(api.system.updateMessageContent, { internalKey, messageId, content, ...fields });
    };
    await reply("- A landing page is running in the preview.", { suggestions: [OLD_CHIP], firstBuild: true });
    await reply("- Added a pricing section.", { suggestions: [CHIP, "Add a footer"] });

    await page.goto(`/projects/${projectId}`);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await expect(page.getByText("Added a pricing section.")).toBeVisible({ timeout: 60_000 });

    // Chips only under the latest reply; one fills the composer, unsent.
    await expect(page.getByRole("button", { name: OLD_CHIP })).toHaveCount(0);
    await page.getByRole("button", { name: CHIP }).click();
    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    await expect(composer).toHaveValue(CHIP);
    await composer.fill("");

    // One card, under the first build's reply. Each button opens the IDE's own UI.
    const card = page.getByRole("group", { name: "Share your app" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Your app is running in the preview");
    await page.screenshot({ path: testInfo.outputPath("ship-card.png") });
    await card.getByRole("button", { name: "Publish to showcase" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await card.getByRole("button", { name: "Export to GitHub" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    // Dismissed for good.
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Added a pricing section.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("group", { name: "Share your app" })).toHaveCount(0);
  });
});
