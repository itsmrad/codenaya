import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * Per-run diff and single-file revert (#225). The stub's run edits
 * `SEEDED_FILE` and creates `ADDED_FILE`; the user reviews the diff, reverts
 * only the edit, and the editor shows the old content again.
 *
 * Like `checkpoints-restore.spec.ts`, this needs the Inngest dev server
 * serving this app, and a Convex deployment with `checkpoints.listChanges`,
 * `fileDiff` and `revertFile`.
 */

const SEEDED_FILE = "seeded.ts";
const ADDED_FILE = "added-by-agent.ts";
const BEFORE = "export const seeded = 1;\n";
const AFTER = "export const seeded = 2;\n";
const STUB_REPLY = "Edited the file";

/** Switches the theme in place (next-themes listens for this). */
const switchTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((value) => {
    localStorage.setItem("theme", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: value }));
  }, theme);

test.describe.serial("run diff", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-run-diff-${Date.now()}-wxyz`;
  const label = `Run diff ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;
  let seededId: Id<"files">;

  const files = async () =>
    Object.fromEntries(
      await Promise.all(
        (await (await userConvexClient(page)).query(api.files.getFiles, { projectId })).map(
          async (file) => [
            file.name,
            (await (await userConvexClient(page)).query(api.files.getFile, { id: file._id }))?.content,
          ],
        ),
      ),
    );

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    const user = await userConvexClient(page);
    projectId = await user.mutation(api.projects.create, { name: `e2e-run-diff-${Date.now()}` });
    seededId = await user.mutation(api.files.createFile, { projectId, name: SEEDED_FILE, content: BEFORE });

    stub = await startStubProvider(apiKey, {
      reply: STUB_REPLY,
      toolCall: { name: "updateFile", arguments: { fileId: seededId, content: AFTER } },
      // One more write after the edit, so the revert has a file to leave alone.
      followUp: (request) =>
        request.messages.filter((m) => m.role === "tool").length === 1
          ? {
              name: "createFiles",
              arguments: { parentId: "", files: [{ name: ADDED_FILE, content: "export {};\n" }] },
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

  test("shows the run's diff and reverts one file", async () => {
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
    await input.fill(`run diff e2e ${Date.now()}`);
    await input.press("Enter");
    await expect(page.getByText(STUB_REPLY)).toBeVisible({ timeout: 120_000 });

    // The summary carries the line counts; the strip opens the diff.
    await expect(page.getByText(/2 files changed \+2 −1/)).toBeVisible();
    await page.getByRole("button", { name: /Review changes/ }).click();
    const dialog = page.getByRole("dialog", { name: "Changes in this run" });
    const list = dialog.getByRole("list", { name: "Changed files" });
    await expect(list.getByRole("button")).toHaveText([/added-by-agent\.ts/, /seeded\.ts/]);

    await list.getByRole("button", { name: /seeded\.ts/ }).click();
    await expect(dialog.locator(".cm-content")).toContainText("seeded = 2");
    await expect(dialog.locator(".cm-deletedChunk")).toContainText("seeded = 1");

    for (const theme of ["dark", "light"] as const) {
      await switchTheme(page, theme);
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 860 });
        await page.screenshot({ path: `test-results/run-diff-${theme}-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 860 });

    await dialog.getByRole("button", { name: "Revert this file" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`Revert ${SEEDED_FILE}?`);
    await confirm.getByRole("button", { name: "Revert" }).click();
    await expect(page.getByText(`Reverted ${SEEDED_FILE}`)).toBeVisible();

    // Only the edit is undone; the created file stays.
    await expect.poll(files).toEqual({ [SEEDED_FILE]: BEFORE, [ADDED_FILE]: "export {};\n" });
    await expect(list.getByRole("button")).toHaveText([/added-by-agent\.ts/]);
    await page.keyboard.press("Escape");

    await page.locator('[data-slot="changed-files"]').getByRole("button", { name: SEEDED_FILE }).click();
    await expect(page.locator(".cm-content").first()).toContainText("seeded = 1");

    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
