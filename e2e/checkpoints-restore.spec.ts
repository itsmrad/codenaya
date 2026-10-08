import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * Checkpoints (#43): an agent run edits the project, then "Restore to before
 * this run" puts the files back.
 *
 * The run is real (Inngest + a local OpenAI-compatible stub on a BYOK key, as
 * in `byok-agent-run.spec.ts`), so this needs the Inngest dev server serving
 * this app. The stub's one tool call creates `ADDED_FILE` at the root.
 */

const ADDED_FILE = "added-by-agent.ts";
const SEEDED_FILE = "seeded.ts";
const STUB_REPLY = "Added the file";

test.describe.serial("checkpoints", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-checkpoint-${Date.now()}-wxyz`;
  const label = `Checkpoint run ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;

  const fileNames = async () =>
    (await (await userConvexClient(page)).query(api.files.getFiles, { projectId }))
      .map((file) => file.name)
      .sort();

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, {
      reply: STUB_REPLY,
      toolCall: {
        name: "createFiles",
        arguments: { parentId: "", files: [{ name: ADDED_FILE, content: "export {};\n" }] },
      },
    });
    page = await browser.newPage();
    await signIn(page);
    const user = await userConvexClient(page);
    projectId = await user.mutation(api.projects.create, {
      name: `e2e-checkpoints-${Date.now()}`,
    });
    await user.mutation(api.files.createFile, {
      projectId,
      name: SEEDED_FILE,
      content: "export const seeded = true;\n",
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
    if (!page) return;
    const user = await userConvexClient(page);
    if (keyId) await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    if (projectId) await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    await page?.close();
    stub?.server.close();
  });

  test("restores the files from before an agent run", async () => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    const before = await fileNames();
    expect(before).toEqual([SEEDED_FILE]);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    // The dev-tools badge covers the composer's bottom-left corner.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const trigger = page.getByRole("combobox", { name: "Agent model" });
    await trigger.click();
    await page
      .getByRole("group", { name: new RegExp(label) })
      .getByRole("option", { name: STUB_MODEL })
      .click();

    const prompt = `checkpoint e2e ${Date.now()}: add a file`;
    const input = page.getByPlaceholder("Describe a change or ask a question…");
    await input.fill(prompt);
    await input.press("Enter");

    // The run changed the files.
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });
    await expect.poll(fileNames).toEqual([ADDED_FILE, SEEDED_FILE].sort());
    await page.screenshot({ path: "test-results/checkpoints-after-run.png" });

    // Restore asks first, then puts the pre-run files back.
    const restore = page.getByRole("button", { name: "Restore to before this run" });
    await restore.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Restore to before this run?");
    await page.screenshot({ path: "test-results/checkpoints-confirm.png" });
    await confirm.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Files restored")).toBeVisible();
    await expect.poll(fileNames).toEqual(before);

    // The history lists the run's checkpoint under its prompt.
    await page.getByRole("button", { name: "Version history" }).click();
    const history = page.getByRole("dialog", { name: "Version history" });
    await expect(history.getByText(prompt)).toBeVisible();
    await page.screenshot({ path: "test-results/checkpoints-history.png" });

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
