import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * Files locked from AI edits (#307). The user locks `SEEDED_FILE`; the stub
 * asks updateFile to rewrite it. The step fails with the lock message, the run
 * carries on, and the file keeps its content.
 *
 * Like `run-diff-revert.spec.ts`, this needs the Inngest dev server serving
 * this app.
 */

const SEEDED_FILE = "seeded.ts";
const BEFORE = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
const STUB_REPLY = "Left the locked file alone";

test.describe.serial("agent file locks", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-file-lock-${Date.now()}-wxyz`;
  const label = `File lock ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;
  let seededId: Id<"files">;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    const user = await userConvexClient(page);
    projectId = await user.mutation(api.projects.create, { name: `e2e-file-lock-${Date.now()}` });
    seededId = await user.mutation(api.files.createFile, { projectId, name: SEEDED_FILE, content: BEFORE });
    await user.mutation(api.files.setLocked, { id: seededId, locked: true });

    stub = await startStubProvider(apiKey, {
      reply: STUB_REPLY,
      toolCall: { name: "updateFile", arguments: { path: SEEDED_FILE, content: "overwritten" } },
    });
    const response = await page.request.post("/api/ai-providers", {
      data: { provider: "custom", apiKey, label, baseUrl: stub.baseUrl, modelIds: [STUB_MODEL] },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;
  });

  test.afterAll(async () => {
    if (!page) return;
    const user = await userConvexClient(page);
    if (keyId) await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    if (projectId) await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    await page?.close();
    stub?.server.close();
  });

  test("refuses the write with the lock message and leaves the file unchanged", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("combobox", { name: "Agent model" }).click();
    await page
      .getByRole("group", { name: new RegExp(label) })
      .getByRole("option", { name: STUB_MODEL })
      .click();
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(`file lock e2e ${Date.now()}`);
    await input.press("Enter");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });

    const runBlock = page.getByRole("button", { name: /Worked/ }).last();
    await expect(runBlock).toHaveAttribute("aria-expanded", "false");
    await runBlock.click();
    await test.info().attach("run-block", { body: await page.screenshot(), contentType: "image/png" });

    await expect(page.getByRole("button", { name: new RegExp(`${SEEDED_FILE} is locked by the user`) })).toBeVisible();

    // The explorer marks the locked row.
    await expect(page.getByLabel("Locked from AI edits")).toBeVisible();
    await test.info().attach("explorer", { body: await page.screenshot(), contentType: "image/png" });

    const user = await userConvexClient(page);
    await expect
      .poll(async () => (await user.query(api.files.getFile, { id: seededId }))?.content)
      .toBe(BEFORE);
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
