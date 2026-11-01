import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, type StubChatRequest, startStubProvider } from "./stub-provider";

/**
 * A follow-up gets the earlier turn as chat messages (#293): "make it dark"
 * reaches the model after "build a todo app" and the reply to it. A stub
 * provider (see `stub-provider.ts`) plays the model, so this needs the
 * Inngest dev server serving this app, as in `byok-agent-run.spec.ts`.
 */

const FIRST = "Build a todo app";
const SECOND = "Now make it dark";
const replyTo = (request: StubChatRequest) =>
  JSON.stringify(request.messages).includes(SECOND) ? "Made it dark." : "Built the todo app.";

test("a follow-up request receives the first turn as history", async ({ page }) => {
  test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  test.setTimeout(240_000);

  const apiKey = `sk-e2e-history-${Date.now()}-wxyz`;
  const label = `History ${Date.now()}`;
  const stub = await startStubProvider(apiKey, { reply: replyTo });
  let keyId: Id<"aiProviderKeys"> | undefined;
  let projectId: Id<"projects"> | undefined;

  try {
    await signIn(page);
    const user = await userConvexClient(page);
    const response = await page.request.post("/api/ai-providers", {
      data: { provider: "custom", apiKey, label, baseUrl: stub.baseUrl, modelIds: [STUB_MODEL] },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;
    projectId = await user.mutation(api.projects.create, { name: `e2e-history-${Date.now()}` });

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page.getByRole("group", { name: new RegExp(label) }).getByRole("option", { name: STUB_MODEL }).click();
    await expect(trigger).toHaveText(STUB_MODEL);

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(FIRST);
    await input.press("Enter");
    await expect(page.getByText("Built the todo app.")).toBeVisible({ timeout: 120_000 });

    await input.fill(SECOND);
    await input.press("Enter");
    await expect(page.getByText("Made it dark.")).toBeVisible({ timeout: 120_000 });

    const followUp = stub.requests.find(
      (request) => request.tools?.length && JSON.stringify(request.messages).includes(SECOND),
    );
    expect(
      followUp?.messages.slice(1, 4).map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: "user", content: FIRST },
      { role: "assistant", content: "Built the todo app." },
      { role: "user", content: SECOND },
    ]);
    expect(JSON.stringify(followUp?.messages[0])).not.toContain(FIRST);
  } finally {
    const user = await userConvexClient(page).catch(() => undefined);
    if (keyId) await user?.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    if (projectId) await user?.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    stub.server.close();
  }
});
