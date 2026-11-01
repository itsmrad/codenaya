import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { type StubChatRequest, startStubProvider } from "./stub-provider";

/**
 * A run going in circles (#306): the stub rewrites one file until the loop
 * detector stops the run, which then shows the hand-off card. Needs the
 * Inngest dev server serving this app, as in `byok-agent-run.spec.ts`.
 */

const EXPLANATION = "I rewrote main.ts four times and the error stayed.";
const PROMPT = "Fix the entry point";
// The key offers the run's model and the one a tier up (`nextTier`).
const RUN_MODEL = "x-ai/grok-4.7";
const RETRY_MODEL = "anthropic/claude-sonnet-5.5";

const toolResults = (request: StubChatRequest) =>
  request.messages.filter((message) => message.role === "tool").length;

/** createFiles, listFiles for the id, then updateFile on it until tools are off. */
const rewriteForever = (request: StubChatRequest) => {
  if ((request as { tool_choice?: unknown }).tool_choice === "none") return undefined;
  if (toolResults(request) === 1) return { name: "listFiles", arguments: {} };
  const fileId = /([a-z0-9]{28,34})\W+name\W+main\.ts/.exec(JSON.stringify(request.messages))?.[1];
  return { name: "updateFile", arguments: { fileId, content: "export const start = () => {};\n" } };
};

test.describe.serial("stuck agent run", () => {
  test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  const apiKey = `sk-e2e-stuck-run-${Date.now()}-wxyz`;
  const label = `Stuck run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys"> | undefined;
  let projectId: Id<"projects"> | undefined;

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      reply: EXPLANATION,
      toolCall: { name: "createFiles", arguments: { parentId: "", files: [{ name: "main.ts", content: "start();\n" }] } },
      followUp: rewriteForever,
    });
    page = await browser.newPage();
    await signIn(page);
    const response = await page.request.post("/api/ai-providers", {
      data: { provider: "custom", apiKey, label, baseUrl: stub.baseUrl, modelIds: [RUN_MODEL, RETRY_MODEL] },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;
  });

  test.afterAll(async () => {
    const user = page && (await userConvexClient(page));
    if (keyId) await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    if (projectId) await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    await page?.close();
    stub?.server.close();
  });

  test("stops early, shows the hand-off card, and retries one tier up", async () => {
    test.setTimeout(180_000);
    const user = await userConvexClient(page);
    projectId = await user.mutation(api.projects.create, { name: `e2e-stuck-run-${Date.now()}` });

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "New conversation" }).click();
    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page.getByRole("group", { name: new RegExp(label) }).getByRole("option", { name: RUN_MODEL }).click();

    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(PROMPT);
    await input.press("Enter");

    const card = page.getByRole("group", { name: "The agent got stuck" });
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(EXPLANATION)).toBeVisible();
    await expect(page.getByText(/I processed your request/)).toHaveCount(0);
    await test.info().attach("stuck-card", { body: await page.screenshot(), contentType: "image/png" });

    // createFiles, listFiles, four rewrites, then the no-tools explanation.
    const coding = stub.requests.filter((request) => request.tools?.length);
    expect(coding).toHaveLength(7);

    await expect(card.getByRole("button", { name: /Diagnose in Plan mode/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /Restore to before this run/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /Open main\.ts/ })).toBeVisible();
    const retry = card.getByRole("button", { name: /Retry on Claude Sonnet 5\.5 · ~\$0\.15–\$0\.30/ });
    await expect(retry).toBeVisible();

    await card.getByRole("button", { name: /Diagnose in Plan mode/ }).click();
    await expect(input).toHaveValue(/The last run got stuck/);
    await expect(page.getByRole("button", { name: "Plan", exact: true, pressed: true })).toBeVisible();
    await input.fill("");

    const before = stub.requests.length;
    await retry.click();
    await expect(trigger).toHaveText(RETRY_MODEL);
    await expect.poll(() => stub.requests.slice(before).some((r) => r.model === RETRY_MODEL)).toBe(true);
    const resent = stub.requests.slice(before).find((r) => r.model === RETRY_MODEL && r.tools?.length);
    expect(JSON.stringify(resent?.messages)).toContain(PROMPT);
  });
});
