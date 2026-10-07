import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, STUB_TITLE, startStubProvider } from "./stub-provider";

/**
 * Agent runs on the user's own key (BYOK), end to end.
 *
 * A local OpenAI-compatible stub stands in for the provider (see
 * `stub-provider.ts`). Inference goes through Inngest's `step.ai.infer`, so
 * this needs the Inngest dev server serving this app (`INNGEST_DEV` /
 * `INNGEST_BASE_URL` pointing at it).
 */

const STUB_REPLY = "Hello from your own key";

test.describe.serial("agent runs on the user's own key", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-byok-run-${Date.now()}-wxyz`;
  const label = `BYOK run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  // A project of its own: chat specs running alongside on the shared fixture
  // project would otherwise switch conversations under this one.
  let projectId: Id<"projects">;

  const keyStatus = async () =>
    (await (await userConvexClient(page)).query(api.aiProviders.list, {})).find(
      (key) => key._id === keyId,
    )?.status;

  const openNewChat = async () => {
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();
  };

  const sendPrompt = async (text: string) => {
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(text);
    await input.press("Enter");
    await expect(page.getByText(text)).toBeVisible();
  };

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, { reply: STUB_REPLY });
    page = await browser.newPage();
    await signIn(page);
    projectId = await (await userConvexClient(page)).mutation(api.projects.create, {
      name: `e2e-byok-${Date.now()}`,
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
    if (keyId) {
      await (await userConvexClient(page))
        .mutation(api.aiProviders.remove, { keyId })
        .catch(() => {});
    }
    if (projectId) {
      await (await userConvexClient(page))
        .mutation(api.projects.remove, { id: projectId })
        .catch(() => {});
    }
    await page?.close();
    stub?.server.close();
  });

  test("the switcher lists the key and a run uses it", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    await openNewChat();

    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await expect(page.getByRole("group", { name: "Codenaya" })).toBeVisible();
    const keyGroup = page.getByRole("group", { name: new RegExp(label) });
    await expect(keyGroup).toBeVisible();
    await keyGroup.getByRole("option", { name: STUB_MODEL }).click();
    await expect(trigger).toHaveText(STUB_MODEL);

    await sendPrompt(`byok e2e ${Date.now()}: list the files`);

    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(STUB_TITLE).first()).toBeVisible({ timeout: 30_000 });
    // The run block names the provider and model.
    await expect(page.getByText(new RegExp(`${label} · ${STUB_MODEL}`))).toBeVisible();
    expect(stub.models.length).toBeGreaterThan(0);
    expect(new Set(stub.models)).toEqual(new Set([STUB_MODEL]));

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("a key the provider rejects ends the run with a link to settings", async () => {
    test.setTimeout(180_000);
    stub.reject();
    const calls = stub.models.length;
    await openNewChat();
    await expect(page.getByRole("combobox", { name: "Agent model" })).toHaveText(STUB_MODEL);

    await sendPrompt(`byok e2e rejected ${Date.now()}`);

    // Chat links render as buttons that confirm before opening (link safety).
    const link = page.getByRole("button", { name: "Settings → AI providers" }).last();
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await link.click();
    await expect(page.getByText(/\/settings\/ai-providers/)).toBeVisible();
    await page.keyboard.press("Escape");
    // Marked invalid, and nothing fell back to the platform key.
    await expect.poll(keyStatus).toBe("invalid");
    expect(stub.models.length).toBe(calls);
  });

  test("an invalid key fails the next run straight away", async () => {
    test.setTimeout(120_000);
    await openNewChat();
    await sendPrompt(`byok e2e invalid ${Date.now()}`);

    const link = page.getByRole("button", { name: "Settings → AI providers" }).last();
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  });
});
