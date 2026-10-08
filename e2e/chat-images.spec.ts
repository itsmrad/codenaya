import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * Images attached in the chat composer reach the agent.
 *
 * The run goes to a local OpenAI-compatible stub registered as a custom BYOK
 * key (see `stub-provider.ts`), so it needs the Inngest dev server serving
 * this app, like `byok-agent-run.spec.ts`.
 */

const STUB_REPLY = "I can see your screenshot";

// A 1×1 PNG.
const PNG = {
  name: "screenshot.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
};

const hasImagePart = (content: unknown) =>
  Array.isArray(content) &&
  content.some(
    (part: { type?: string; image_url?: { url?: string } }) =>
      part.type === "image_url" && /^https?:\/\//.test(part.image_url?.url ?? ""),
  );

test.describe.serial("chat image attachments", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-chat-images-${Date.now()}-wxyz`;
  const label = `Images ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;

  const openNewChat = async () => {
    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByText("What do you want to build?")).toBeVisible();
  };

  const pickModel = async (group: string | RegExp, model: string) => {
    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page
      .getByRole("group", { name: group })
      .getByRole("option", { name: model })
      .click();
    await expect(trigger).toHaveText(model);
  };

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, { reply: STUB_REPLY });
    page = await browser.newPage();
    await signIn(page);
    projectId = await (await userConvexClient(page)).mutation(api.projects.create, {
      name: `e2e-images-${Date.now()}`,
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
    const client = page && (await userConvexClient(page).catch(() => null));
    if (client && keyId) {
      await client.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    }
    if (client && projectId) {
      await client.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
    await page?.close();
    stub?.server.close();
  });

  test("a model without vision gets a hint instead of a send", async () => {
    const errors = collectConsoleErrors(page);
    await openNewChat();

    await page.getByLabel("Upload files").setInputFiles(PNG);
    await expect(page.getByRole("img", { name: PNG.name })).toBeVisible();

    await pickModel("Codenaya", "GLM 5.3");
    await expect(
      page.getByRole("alert").filter({ hasText: "can't read images" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    await pickModel("Codenaya", "GPT-5.6 Luna");
    await expect(page.getByText("can't read images")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  test("an attached image shows in the message and reaches the agent", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    await openNewChat();
    await pickModel(new RegExp(label), STUB_MODEL);

    const text = `images e2e ${Date.now()}: match this screenshot`;
    await page.getByLabel("Upload files").setInputFiles(PNG);
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(text);
    await input.press("Enter");

    await expect(page.getByText(text)).toBeVisible();
    const thumbnail = page.getByRole("img", { name: "Attached image 1" });
    await expect(thumbnail).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    // The composer is cleared once the message is sent.
    await expect(page.getByRole("img", { name: PNG.name })).toHaveCount(0);

    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });
    const agentRequests = stub.requests.filter((request) => request.tools?.length);
    expect(agentRequests.length).toBeGreaterThan(0);
    for (const request of agentRequests) {
      const user = request.messages.find((message) => message.role === "user");
      expect(hasImagePart(user?.content), "user message carries the image").toBe(true);
    }

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
