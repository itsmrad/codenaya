import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

// Wiring smoke only: E2B and the dying service are stubbed. No sandbox or LLM spend.
test("esbuild death recovers once, waits for install, and bypasses AI repair (#776)", async ({ page }) => {
  test.skip(!hasClerkCredentials() || !hasPreviewFixtureEnv(), "Needs Clerk and Convex fixtures");
  test.setTimeout(120_000);
  const previewUrl = "https://esbuild-preview.test/";
  let recoveries = 0;
  let messages = 0;
  await page.route(`${previewUrl}**`, (route) => route.fulfill({ contentType: "text/html", body: "<h1>Bakery</h1>" }));
  await page.route("**/api/sandbox", (route) => route.fulfill({
    contentType: "application/x-ndjson",
    body: JSON.stringify({ type: "ready", sandboxId: "esbuild-smoke", previewUrl }) + "\n",
  }));
  await page.route("**/api/sandbox/*", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ action: "recover-esbuild" });
      recoveries++;
      await route.fulfill({ json: { status: recoveries === 1 ? "busy" : "restarted" } });
    } else await route.fulfill({ json: { success: true } });
  });
  await page.route("**/api/messages", async (route) => {
    messages++;
    await route.fulfill({ json: {} });
  });
  await signIn(page);
  const projectId = await seedPreviewProject(page, "e2e-preview-esbuild-recovery");
  const user = await userConvexClient(page);
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  await system.mutation(api.system.createFile, { internalKey, projectId, name: "package.json", content: "{}\n" });
  const conversationId = await user.mutation(api.conversations.create, { projectId, title: "Follow-up edit" });
  // Arm the existing automatic-fix window by ending a run after preview boot.
  const messageId = await system.mutation(api.system.createMessage, {
    internalKey, projectId, conversationId, role: "assistant", content: "", status: "processing",
  });
  try {
    await page.goto(`/projects/${projectId}?view=preview`);
    await expect(page.frameLocator('iframe[title="Preview"]').getByRole("heading", { name: "Bakery" })).toBeVisible({ timeout: 60_000 });
    await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" });
    const frame = page.frame({ url: previewUrl })!;
    const report = () => frame.evaluate(() => {
      for (let i = 0; i < 3; i++) parent.postMessage({
        source: "codenaya-preview", version: 1, kind: "build",
        message: "The service is no longer running: write EPIPE", file: "node_modules/esbuild/lib/main.js:718",
      }, "*");
    });
    await report();
    await expect(page.getByRole("status").filter({ hasText: "Recovering preview" })).toBeVisible();
    await expect.poll(() => recoveries).toBe(2); // One install wait, then one restart.
    await expect(page.getByRole("button", { name: "Fix with AI" })).toHaveCount(0);
    // Simulate Vite's own reconnect/reload report; no IDE iframe reload is added.
    await frame.evaluate(() => parent.postMessage({ source: "codenaya-preview", version: 1, kind: "page", message: "" }, "*"));
    await expect(page.getByRole("status").filter({ hasText: "Preview unavailable" })).toHaveCount(0);
    await report();
    await page.waitForTimeout(7_000); // Past the unchanged automatic-fix delay.
    expect(recoveries).toBe(2); // Repeated overlay within cooldown cannot loop.
    expect(messages).toBe(0);
    await expect(page.getByRole("button", { name: "Fix with AI" })).toHaveCount(0);
  } finally {
    await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" });
    await user.mutation(api.projects.remove, { id: projectId });
  }
});
