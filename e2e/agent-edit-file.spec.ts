import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * The agent's editFile tool (#291). The stub edits one line of `SEEDED_FILE`,
 * then sends an edit whose oldText no longer matches; the run block shows the
 * first as a write and the second as a failed step, and the run carries on.
 *
 * Like `run-diff-revert.spec.ts`, this needs the Inngest dev server serving
 * this app.
 */

const SEEDED_FILE = "seeded.ts";
const BEFORE = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
const AFTER = "export const a = 1;\nexport const b = 20;\nexport const c = 3;\n";
const STUB_REPLY = "Edited the file";

test.describe.serial("agent editFile", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-edit-file-${Date.now()}-wxyz`;
  const label = `Edit file ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;
  let seededId: Id<"files">;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    const user = await userConvexClient(page);
    projectId = await user.mutation(api.projects.create, { name: `e2e-edit-file-${Date.now()}` });
    seededId = await user.mutation(api.files.createFile, { projectId, name: SEEDED_FILE, content: BEFORE });

    stub = await startStubProvider(apiKey, {
      reply: STUB_REPLY,
      toolCall: {
        name: "editFile",
        arguments: { path: SEEDED_FILE, edits: [{ oldText: "b = 2;", newText: "b = 20;" }] },
      },
      // The same edit again: its oldText is gone, so it must fail and write nothing.
      followUp: (request) =>
        request.messages.filter((m) => m.role === "tool").length === 1
          ? {
              name: "editFile",
              arguments: { path: SEEDED_FILE, edits: [{ oldText: "b = 2;", newText: "b = 99;" }] },
            }
          : undefined,
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

  test("shows the edit as a write, the failed edit with its error, and changes only the edited span", async () => {
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
    await input.fill(`edit file e2e ${Date.now()}`);
    await input.press("Enter");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });

    const runBlock = page.getByRole("button", { name: /Worked/ }).last();
    await expect(runBlock).toHaveAttribute("aria-expanded", "false");
    await runBlock.click();
    await test.info().attach("run-block", { body: await page.screenshot(), contentType: "image/png" });

    await expect(page.getByText("Edited").first()).toBeVisible();
    await expect(page.getByRole("button", { name: SEEDED_FILE }).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /oldText #1 matched 0 times; re-read the file/ }),
    ).toBeVisible();

    const user = await userConvexClient(page);
    await expect
      .poll(async () => (await user.query(api.files.getFile, { id: seededId }))?.content)
      .toBe(AFTER);
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
