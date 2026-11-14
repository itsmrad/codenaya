import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { type StubChatRequest, startStubProvider } from "./stub-provider";

/**
 * A run going in circles (#306): the stub keeps rewriting one file that
 * doesn't parse until the loop detector stops the run, which then shows the
 * hand-off card. Needs the
 * Inngest dev server serving this app, as in `byok-agent-run.spec.ts`.
 */

const EXPLANATION = "I rewrote main.ts three times and it still doesn't parse.";
const PROMPT = "Fix the entry point";
// The key offers the run's model and the one a tier up (`nextTier`).
const RUN_MODEL = "x-ai/grok-4.7";
const RETRY_MODEL = "anthropic/claude-sonnet-5.5";

/** After writeFiles, updateFile on the same path until tools are off. */
const rewriteForever = (request: StubChatRequest) =>
  (request as { tool_choice?: unknown }).tool_choice === "none"
    ? undefined
    : { name: "updateFile", arguments: { path: "src/main.ts", content: "export const start = (\n" } };

test.describe.serial("stuck agent run", () => {
  test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  const apiKey = `sk-e2e-stuck-run-${Date.now()}-wxyz`;
  const label = `Stuck run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys"> | undefined;
  let projectId: Id<"projects"> | undefined;
  const fileNames = async () =>
    (await (await userConvexClient(page)).query(api.files.getFiles, { projectId: projectId! }))
      .map((file) => file.name)
      .sort();

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      reply: EXPLANATION,
      toolCall: { name: "writeFiles", arguments: { files: [{ path: "src/main.ts", content: "start();\n" }] } },
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
    test.setTimeout(300_000);
    const user = await userConvexClient(page);
    projectId = await user.mutation(api.projects.create, { name: `e2e-stuck-run-${Date.now()}` });
    const filesBefore = await fileNames();

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

    // writeFiles, three broken rewrites, then the no-tools explanation.
    const coding = stub.requests.filter((request) => request.tools?.length);
    expect(coding).toHaveLength(5);
    await expect(card).toContainText("failed to parse 3 times");

    await expect(card.getByRole("button", { name: /Diagnose in Plan mode/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /Restore to before this run/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /Open main\.ts/ })).toBeVisible();
    const retry = card.getByRole("button", { name: /Retry on Claude Sonnet 5\.5 · ~\$0\.15–\$0\.30/ });
    await expect(retry).toBeVisible();

    // Diagnose keeps the draft and moves focus to the composer.
    await input.fill("My draft");
    await card.getByRole("button", { name: /Diagnose in Plan mode/ }).click();
    await expect(input).toHaveValue(/^My draft\nThe last run got stuck/);
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: "Plan", exact: true, pressed: true })).toBeVisible();
    await input.fill("");

    const before = stub.requests.length;
    await retry.click();
    await expect(trigger).toHaveText(RETRY_MODEL);
    // Tools-bearing only: the key check's no-tools "hi" probe uses the retry model first.
    const resentOnRetryModel = (r: StubChatRequest) => r.model === RETRY_MODEL && Boolean(r.tools?.length);
    await expect.poll(() => stub.requests.slice(before).some(resentOnRetryModel)).toBe(true);
    const resent = stub.requests.slice(before).find(resentOnRetryModel);
    expect(JSON.stringify(resent?.messages)).toContain(PROMPT);

    // The stub loops the retry too; Restore is offered only once no run is going.
    const cards = page.getByRole("group", { name: "The agent got stuck" });
    await expect(cards).toHaveCount(2, { timeout: 120_000 });
    const first = cards.first();

    // Open file shows the file the run looped on in the editor.
    const openFiles = page.getByRole("navigation", { name: "Open files" });
    await first.getByRole("button", { name: /Open main\.ts/ }).click();
    await expect(openFiles).toContainText("main.ts");

    // Restore with main.ts still open: its tab closes and the project view stays.
    await first.getByRole("button", { name: /Restore to before this run/ }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Restore to before this run?");
    await confirm.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Files restored")).toBeVisible();
    await expect.poll(fileNames).toEqual(filesBefore);
    await expect(openFiles).not.toContainText("main.ts");
    await expect(input).toBeVisible();
    await expect(page.getByRole("heading", { name: "Project not found" })).toHaveCount(0);
  });
});
