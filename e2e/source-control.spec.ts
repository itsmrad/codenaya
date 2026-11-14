import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn, signInAsSpecUser } from "./clerk-auth";
import { cleanupProject, userConvexClient } from "./convex-client";
import { collectConsoleErrors } from "./console-errors";
import { seedPreviewProject } from "./preview-fixtures";

// Seeds snapshots directly. No agent, provider, Inngest or cloud sandbox is needed.
test.describe("source control", () => {
  test.skip(!hasClerkCredentials() || !process.env.CODENAYA_CONVEX_INTERNAL_KEY,
    "Needs Clerk pool credentials and the DEV internal key; branch APIs must be on an isolated local backend");

  const setTheme = (page: Page, theme: string) => page.evaluate((value) => {
    localStorage.setItem("theme", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: value }));
  }, theme);

  test("compares all project changes, selects a file, confirms discard and opens from the palette", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    test.skip(!process.env.E2E_PROJECT_ID, "Needs the Clerk pool's fixture project");
    const projectId = process.env.E2E_PROJECT_ID as Id<"projects">;
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const user = await userConvexClient(page);
    const errors = collectConsoleErrors(page);
    await cleanupProject(system, internalKey, projectId);
    try {
      const edited = await user.mutation(api.files.createFile, { projectId, name: "edited.ts", content: "export const version = 1;\n" });
      const deleted = await user.mutation(api.files.createFile, { projectId, name: "deleted.ts", content: "export {};\n" });
      const conversationId = await user.mutation(api.conversations.create, { projectId, title: "Source control fixture" });
      const messageId = await system.mutation(api.system.createMessage, { internalKey, projectId, conversationId, role: "assistant", content: "Fixture only", status: "completed" });
      await system.mutation(api.system.createProjectCheckpoint, { internalKey, projectId, messageId, label: "Before fixture run" });
      await user.mutation(api.files.updateFile, { id: edited, content: "export const version = 2;\n" });
      await user.mutation(api.files.createFile, { projectId, name: "added.ts", content: "export const added = true;\n" });
      // This newer non-run checkpoint must not become the default baseline.
      await user.mutation(api.checkpoints.deleteFileWithUndo, { id: deleted });

      await page.goto(`/projects/${projectId}`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.getByRole("tab", { name: "Code", exact: true }).click();
      const filesTab = page.getByRole("tab", { name: "Files", exact: true });
      const sourceTab = page.getByRole("tab", { name: "Source control", exact: true });
      await filesTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect(sourceTab).toHaveAttribute("aria-selected", "true");
      const pane = page.getByRole("region", { name: "Source control", exact: true });
      const list = pane.getByRole("list", { name: "Project changed files" });
      await expect(list.getByRole("button")).toHaveText([/added.ts/, /deleted.ts/, /edited.ts/]);
      await expect(pane.getByRole("combobox")).toContainText("Before fixture run");
      await expect(pane).toContainText("No linked repository");
      await expect(pane).toContainText("checkpoints, without per-run commit SHAs");

      // Phone and desktop layouts remount the IDE (chat tab, Files view); reopen the panel.
      const showPane = async (width: number) => {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("tab", { name: "Code", exact: true }).click();
        await sourceTab.click();
        await expect(list.getByRole("button")).toHaveCount(3);
      };
      for (const theme of ["light", "dark"]) {
        await setTheme(page, theme);
        for (const width of [1440, 375]) {
          await showPane(width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
          await page.screenshot({ path: `test-results/source-control-${theme}-${width}.png` });
        }
      }
      const dialog = page.getByRole("dialog", { name: "Project changes", exact: true });
      for (const width of [375, 1440]) {
        await showPane(width);
        await list.getByRole("button", { name: /edited.ts/ }).click();
        await expect(dialog.locator(".cm-content")).toContainText("version = 2");
        await expect(dialog.locator(".cm-deletedChunk")).toContainText("version = 1");
        await page.screenshot({ path: `test-results/source-control-diff-${width}.png` });
        if (width === 375) {
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        }
      }
      await dialog.getByRole("button", { name: "Discard file changes" }).click();
      const confirm = page.getByRole("alertdialog");
      await expect(confirm).toContainText("Discard changes to edited.ts?");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog.locator(".cm-content")).toContainText("version = 2");
      await dialog.getByRole("button", { name: "Discard file changes" }).click();
      await confirm.getByRole("button", { name: "Revert", exact: true }).click();
      await expect.poll(async () => (await user.query(api.files.getFile, { id: edited }))?.content).toBe("export const version = 1;\n");
      await expect(confirm).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(list.getByRole("button")).toHaveText([/added.ts/, /deleted.ts/]);

      const history = pane.getByRole("list", { name: "Checkpoint history", exact: true });
      await history.getByRole("button", { name: "Compare to current" }).first().click();
      await expect(pane.getByRole("combobox")).toContainText("Before deleting deleted.ts");
      await expect(list.getByRole("button")).toHaveText([/deleted.ts/, /edited.ts/]);
      await history.getByRole("button", { name: "Restore", exact: true }).first().click();
      await expect(confirm).toContainText("Restore this checkpoint?");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();

      await filesTab.click();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(async () => {
        // "Desktop Chrome" sends a Windows user agent, so the app expects Ctrl on every host.
        await page.keyboard.press("Control+Shift+P");
        await expect(palette).toBeVisible({ timeout: 1_000 });
      }).toPass();
      await palette.getByRole("combobox").fill("source control");
      await palette.getByRole("option", { name: "Show source control" }).click();
      await expect(sourceTab).toHaveAttribute("aria-selected", "true");
      expect(errors).toEqual([]);
    } finally {
      await cleanupProject(system, internalKey, projectId);
    }
  });

  // Chat-first hides the code (#549); the palette command opens it for the visit first.
  test("Show source control opens the code in Chat-first mode", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // A ready preview without E2B, as in workspace-mode.spec.ts.
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
      }),
    );
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
    // A user of its own: the mode is account-wide and would change other specs' layout.
    await signInAsSpecUser(page, "source-control-chat");
    await page.goto("/settings/workspace");
    const chatFirst = page.getByRole("radio", { name: /Chat-first/ });
    await chatFirst.click();
    await expect(chatFirst).toBeChecked();

    const projectId = await seedPreviewProject(page, "e2e-source-control-chat");
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole("button", { name: "Open code for this session" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Code", exact: true })).toHaveCount(0);

    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(async () => {
      await page.keyboard.press("Control+Shift+P");
      await expect(palette).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await palette.getByRole("combobox").fill("source control");
    await palette.getByRole("option", { name: "Show source control" }).click();
    await expect(page.getByRole("tab", { name: "Code", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Source control", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: "test-results/source-control-chat-first.png" });
  });
});
