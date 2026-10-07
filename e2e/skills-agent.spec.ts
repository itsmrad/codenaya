import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * The agent sees a project skill in its index, loads it, and the run block
 * shows "Used skill". A stub provider (see `stub-provider.ts`) plays the model,
 * so this needs the Inngest dev server serving this app, as in
 * `byok-agent-run.spec.ts`.
 */

const projectId = process.env.E2E_PROJECT_ID as Id<"projects"> | undefined;
const STUB_REPLY = "Added SEO metadata and a sitemap.";

test.describe("agent skills", () => {
  test.skip(
    !hasClerkCredentials() || !projectId,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID (a project owned by the e2e user)",
  );

  const skillName = `e2e-seo-${Date.now()}`;
  const apiKey = `sk-e2e-skills-${Date.now()}-wxyz`;
  const label = `Skills run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys"> | undefined;
  let skillId: Id<"skills"> | undefined;

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      reply: STUB_REPLY,
      toolCall: { name: "loadSkill", arguments: { name: skillName } },
    });
    page = await browser.newPage();
    await signIn(page);

    const response = await page.request.post("/api/ai-providers", {
      data: {
        provider: "custom",
        apiKey,
        label,
        baseUrl: stub.baseUrl,
        modelIds: [STUB_MODEL],
      },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;

    const user = await userConvexClient(page);
    skillId = await user.mutation(api.skills.create, {
      name: skillName,
      description: "Use when adding SEO metadata or a sitemap",
      body: "# SEO\nExport `metadata` from the root layout and add app/sitemap.ts.",
      projectId,
    });
  });

  test.afterAll(async () => {
    const user = page && (await userConvexClient(page));
    if (skillId) {
      await user.mutation(api.skills.remove, { skillId }).catch(() => {});
    }
    if (keyId) {
      await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    }
    await page?.close();
    stub?.server.close();
  });

  test("the agent loads an enabled skill and the run block shows it", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page
      .getByRole("group", { name: new RegExp(label) })
      .getByRole("option", { name: STUB_MODEL })
      .click();
    await expect(trigger).toHaveText(STUB_MODEL);

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill("Add SEO metadata and a sitemap");
    await input.press("Enter");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });

    await page.getByRole("button", { name: /Worked/ }).last().click();
    await test.info().attach("run-block", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await expect(page.getByText("Used skill")).toBeVisible();
    await expect(page.getByText(skillName, { exact: true })).toBeVisible();

    // The prompt indexed the skill by name and description, without its body,
    // and the tool result handed the body back.
    const prompt = JSON.stringify(stub.requests.find((r) => r.tools?.length)?.messages[0]);
    expect(prompt).toContain(`- ${skillName}: Use when adding SEO metadata or a sitemap`);
    expect(prompt).not.toContain("app/sitemap.ts");
    expect(JSON.stringify(stub.requests.at(-1)?.messages)).toContain("app/sitemap.ts");

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
