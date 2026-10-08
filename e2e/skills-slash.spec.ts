import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * `/skill-name` in the chat composer: the picker lists the project's enabled
 * skills, Enter inserts the name, and the sent run preloads that skill and
 * shows it in the run block. A stub provider (see `stub-provider.ts`) plays
 * the model, so this needs the Inngest dev server serving this app, as in
 * `skills-agent.spec.ts`.
 */

const STUB_REPLY = "Added the sitemap with the forced skill.";

test.describe("skill slash command", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const stamp = Date.now();
  const skillName = `e2e-skill-${stamp}`;
  const disabledName = `e2e-skill-off-${stamp}`;
  const apiKey = `sk-e2e-slash-${stamp}-wxyz`;
  const label = `Slash run ${stamp}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys"> | undefined;
  // A project of its own: chat specs running alongside on the shared fixture
  // project would otherwise switch conversations under this one.
  let projectId: Id<"projects"> | undefined;
  const skillIds: Id<"skills">[] = [];

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, { reply: STUB_REPLY });
    page = await browser.newPage();
    await signIn(page);
    projectId = await (await userConvexClient(page)).mutation(api.projects.create, {
      name: `e2e-skills-slash-${Date.now()}`,
    });

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
  });

  test.afterAll(async () => {
    const user = page && (await userConvexClient(page));
    for (const skillId of skillIds) {
      await user.mutation(api.skills.remove, { skillId }).catch(() => {});
    }
    if (keyId) {
      await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    }
    if (projectId) {
      await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
    await page?.close();
    stub?.server.close();
  });

  test("/ picks an enabled skill and the run force-loads it", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();

    // Project skills start enabled in their project; switch the second off.
    const user = await userConvexClient(page);
    for (const name of [skillName, disabledName]) {
      skillIds.push(
        await user.mutation(api.skills.create, {
          name,
          description: "Use when adding a sitemap",
          body: "# Sitemap\nAdd app/sitemap.ts listing every route.",
          projectId: projectId!,
        }),
      );
    }
    await user.mutation(api.skills.setProjectSkillEnabled, {
      projectId: projectId!,
      skillKey: `user:${skillIds[1]}`,
      enabled: false,
    });

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page
      .getByRole("group", { name: new RegExp(label) })
      .getByRole("option", { name: STUB_MODEL })
      .click();
    await expect(trigger).toHaveText(STUB_MODEL);

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(`/e2e-skill-${stamp}`);
    const menu = page.getByRole("listbox", { name: "Skills" });
    await expect(menu.getByRole("option", { name: new RegExp(`/${skillName}`) })).toBeVisible();
    await expect(menu.getByRole("option", { name: new RegExp(disabledName) })).toHaveCount(0);
    await test.info().attach("slash-menu", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await input.press("Enter");
    await expect(input).toHaveValue(`/${skillName} `);
    await expect(menu).toBeHidden();

    await input.pressSequentially("add a sitemap");
    await input.press("Enter");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });
    // The user bubble shows the skill as a chip, not as typed text.
    await expect(page.getByTitle(`Skill: ${skillName}`)).toBeVisible();

    // A finished run block collapses itself shortly after the run ends; a
    // click before that would close it instead of opening it.
    const runBlock = page.getByRole("button", { name: /Worked/ }).last();
    await expect(runBlock).toHaveAttribute("aria-expanded", "false");
    await runBlock.click();
    await expect(runBlock).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Used skill")).toBeVisible();
    await expect(page.getByText(skillName, { exact: true })).toBeVisible();
    await test.info().attach("run-block", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // The skill's body went in up-front, and the message was sent as typed.
    const coding = stub.requests.find((r) => r.tools?.length);
    expect(JSON.stringify(coding?.messages[0])).toContain("app/sitemap.ts");
    expect(JSON.stringify(coding?.messages)).toContain(`/${skillName} add a sitemap`);

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
