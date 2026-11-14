import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ensureTestUser, hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

/**
 * Stubs the sandbox so the boot resolves at once, after any `output` lines;
 * returns the boot request count.
 */
const stubSandbox = async (page: Page, output: string[] = []) => {
  const counter = { boots: 0 };
  await page.route("**/api/sandbox", (route) => {
    counter.boots += 1;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: [
        ...output.map((data) => ({ type: "output", data })),
        { type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
    });
  });
  // File sync and teardown of the stubbed sandbox.
  await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
  return counter;
};

/** A project with no package.json and a run in progress: the first build. */
const startFirstBuild = async (page: Page, name: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const projectId = await seedPreviewProject(page, name);
  const conversationId = await (await userConvexClient(page)).mutation(api.conversations.create, {
    projectId,
    title: `Auto-open ${Date.now()}`,
  });
  const runs: Id<"messages">[] = [];

  const startRun = async () => {
    const messageId = await system.mutation(api.system.createMessage, {
      internalKey,
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
    });
    runs.push(messageId);
    return {
      complete: () =>
        system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" }),
    };
  };

  return {
    projectId,
    run: await startRun(),
    startRun,
    writePackageJson: () =>
      system.mutation(api.system.createFile, {
        internalKey,
        projectId,
        name: "package.json",
        content: "{}\n",
      }),
    /** Writes `name` as the first run, which lists it on the build card after the file lands. */
    writeFile: async (name: string) => {
      await system.mutation(api.system.createFile, { internalKey, projectId, name, content: `${name}\n` });
      const now = Date.now();
      await system.mutation(api.system.upsertMessageSteps, {
        internalKey,
        messageId: runs[0],
        steps: [
          { id: name, kind: "tool", tool: "writeFiles", targets: [name], status: "done", startedAt: now, endedAt: now },
        ],
      });
    },
    cleanup: () =>
      Promise.all(
        runs.map((messageId) =>
          system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" }),
        ),
      ),
  };
};

test.describe("first build auto-opens the preview", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  for (const [device, width, height] of [["desktop", 1440, 900], ["tablet", 768, 1024]] as const) {
    test(`boots once package.json lands and shows Preview (${device})`, async ({ page }, testInfo) => {
      test.setTimeout(150_000);
      const errors = collectConsoleErrors(page);
      const sandbox = await stubSandbox(page);
      await page.setViewportSize({ width, height });
      await signIn(page);
      const build = await startFirstBuild(page, `e2e-preview-auto-open-${device}`);

      try {
        await page.goto(`/projects/${build.projectId}`);
        // Desktops open on Preview for the first build (#337); tablets stay on the Chat tab.
        const startTab = page.getByRole("tab", { name: device === "desktop" ? "Preview" : "Chat" });
        const previewTab = page.getByRole("tab", { name: "Preview" });
        const iframe = page.locator('iframe[title="Preview"]');
        const stillBuilding = page.getByRole("status", { name: "Still building" });
        await expect(startTab).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
        await page.waitForTimeout(5_000);
        expect(sandbox.boots).toBe(0);

        // Pre-warm: the sandbox boots while the run is still writing.
        await build.writePackageJson();
        await expect.poll(() => sandbox.boots, { timeout: 30_000 }).toBeGreaterThan(0);
        await expect(startTab).toHaveAttribute("aria-selected", "true");
        if (device === "desktop") {
          // The stubbed sandbox is running mid-run: the app shows under the bar.
          await expect(iframe).toBeVisible({ timeout: 30_000 });
          await expect(stillBuilding).toBeVisible();
        }
        await page.screenshot({ path: testInfo.outputPath(`during-build-${device}.png`) });

        await build.run.complete();
        await expect(previewTab).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
        await expect(iframe).toBeVisible();
        await expect(page.getByRole("status", { name: "Building your app" })).toBeHidden();
        await expect(stillBuilding).toBeHidden();
        await page.screenshot({ path: testInfo.outputPath(`auto-opened-${device}.png`) });

        // Later runs leave the selected tab alone and show no bar.
        const codeTab = page.getByRole("tab", { name: "Code" });
        await codeTab.click();
        const second = await build.startRun();
        await page.waitForTimeout(2_000);
        await previewTab.click();
        await expect(page.getByText("Agent working")).toBeVisible();
        await expect(stillBuilding).toBeHidden();
        await codeTab.click();
        await second.complete();
        await page.waitForTimeout(3_000);
        await expect(codeTab).toHaveAttribute("aria-selected", "true");
      } finally {
        await build.cleanup();
      }

      expect(errors).toEqual([]);
    });
  }

  test("holds the boot while the first build keeps writing (#486)", async ({ page }) => {
    test.setTimeout(150_000);
    const sandbox = await stubSandbox(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const build = await startFirstBuild(page, "e2e-preview-auto-open-writing");

    try {
      // The page's time only moves when the test moves it, so slow Convex
      // round trips can't stretch the gap between writes past the window.
      await page.clock.install();
      await page.goto(`/projects/${build.projectId}`);
      const card = page.getByRole("status", { name: "Building your app" });
      await expect(card).toBeVisible({ timeout: 60_000 });
      await page.clock.pauseAt(Date.now() + 1_000);
      await build.writePackageJson();
      // Writes 1s apart, under the 2s quiet window: install would race them.
      for (let index = 0; index < 6; index += 1) {
        const name = `part-${index}.txt`;
        await build.writeFile(name);
        // Listed after the file landed: the page has the write.
        await expect(card.getByText(name)).toBeVisible({ timeout: 30_000 });
        await page.clock.runFor(1_000);
      }
      expect(sandbox.boots).toBe(0);
      // Quiet now: it boots while the run is still going.
      await expect
        .poll(
          async () => {
            await page.clock.runFor(500);
            return sandbox.boots;
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      await expect(page.getByRole("status", { name: "Still building" })).toBeVisible({ timeout: 30_000 });
    } finally {
      await build.cleanup();
    }
  });

  test("covers a broken first build until its run ends, then shows Fixing (#486, #305)", async ({ page }) => {
    test.setTimeout(180_000);
    // The app the run leaves doesn't compile.
    await stubSandbox(page, [
      '[vite] Pre-transform error: Failed to resolve import "./Missing" from "src/App.jsx". Does the file exist?\n',
    ]);
    // Stubbed, so no agent run (or model spend) starts.
    const sent: string[] = [];
    await page.route("**/api/messages", (route) => {
      sent.push((route.request().postDataJSON() as { message: string }).message);
      return route.fulfill({ status: 200, json: {} });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    // A prompt-created project whose first build stays pending: no run here
    // verifies a build, like an unverified one (#501), so every run reads as
    // the first build.
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const { projectId, conversationId } = await system.mutation(api.system.createProjectWithConversation, {
      internalKey,
      projectName: `e2e-preview-auto-open-fixing-${Date.now()}`,
      conversationTitle: "Fixing",
      ownerId: (await ensureTestUser()).id,
      source: "dashboard",
      firstBuildPending: true,
    });
    const startRun = async () => {
      const messageId = await system.mutation(api.system.createMessage, {
        internalKey,
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        status: "processing",
      });
      return () =>
        system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" });
    };

    try {
      const completeBuild = await startRun();
      await page.goto(`/projects/${projectId}`);
      const buildCard = page.getByRole("status", { name: "Building your app" });
      const fixing = page.getByRole("status", { name: "Fixing an error" });
      const banner = page.getByRole("alert").filter({ hasText: "Build error" });
      await expect(buildCard).toBeVisible({ timeout: 60_000 });
      await system.mutation(api.system.createFile, { internalKey, projectId, name: "package.json", content: "{}\n" });

      // The sandbox boots mid-run and reports the half-written app's error:
      // the card stays over it, with no banner and no fix.
      await expect(page.getByRole("button", { name: "Refresh page" })).toBeEnabled({ timeout: 30_000 });
      await page.waitForTimeout(5_000);
      await expect(buildCard).toBeVisible();
      // Covered, so out of the keyboard's and screen readers' reach.
      await expect(page.locator('iframe[title="Preview"]')).toHaveAttribute("inert", "");
      await expect(page.getByRole("status", { name: "Still building" })).toBeHidden();
      await expect(banner).toHaveCount(0);
      expect(sent).toHaveLength(0);

      // The run ends with the error still there: Fixing, and one fix sent.
      await completeBuild();
      await expect(fixing).toBeVisible({ timeout: 30_000 });
      await expect(buildCard).toBeHidden();
      await expect(banner).toHaveCount(0);
      await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(1);
      expect(sent[0]).toContain("Failed to resolve import");

      // The fix run, a first build too: still Fixing, with no second fix.
      const completeFix = await startRun();
      await page.waitForTimeout(5_000);
      await expect(fixing).toBeVisible();
      await expect(banner).toHaveCount(0);
      await completeFix();

      // It left the error: the cover lifts and the banner offers the next step.
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(fixing).toBeHidden();
      await expect(buildCard).toBeHidden();
      await expect(banner).toContainText("Codenaya sent a fix to the agent automatically.");
      await expect(page.locator('iframe[title="Preview"]')).not.toHaveAttribute("inert");
      await expect(banner.getByRole("button", { name: "Fix with AI" })).toBeEnabled();
      await page.waitForTimeout(5_000);
      expect(sent).toHaveLength(1);
    } finally {
      await (await userConvexClient(page)).mutation(api.projects.remove, { id: projectId }).catch(() => {});
    }
  });

  test("keeps the tab the user picked during the first build", async ({ page }) => {
    test.setTimeout(150_000);
    const errors = collectConsoleErrors(page);
    await stubSandbox(page);
    await page.setViewportSize({ width: 768, height: 1024 });
    await signIn(page);
    const build = await startFirstBuild(page, "e2e-preview-auto-open-picked");

    try {
      await page.goto(`/projects/${build.projectId}`);
      const codeTab = page.getByRole("tab", { name: "Code" });
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true", {
        timeout: 60_000,
      });
      // The file tree is out of the accessibility tree behind the chat; give the files a moment to load.
      await page.waitForTimeout(5_000);
      await codeTab.click();
      await build.writePackageJson();
      await page.waitForTimeout(2_000);

      await build.run.complete();
      await page.waitForTimeout(3_000);
      await expect(codeTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await build.cleanup();
    }

    expect(errors).toEqual([]);
  });

  test("a sandbox that fails mid-build shows its error under the bar (desktop)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.route("**/api/sandbox", (route) =>
      route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "error", message: "e2e boot failure" })}\n`,
      }),
    );
    await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const build = await startFirstBuild(page, "e2e-preview-auto-open-error");

    try {
      await page.goto(`/projects/${build.projectId}`);
      await expect(page.getByRole("status", { name: "Building your app" })).toBeVisible({ timeout: 60_000 });
      await build.writePackageJson();
      await expect(page.getByRole("alert").filter({ hasText: "e2e boot failure" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("status", { name: "Building your app" })).toBeHidden();
      await expect(page.getByRole("status", { name: "Still building" })).toBeVisible();
    } finally {
      await build.cleanup();
    }
  });

  test("a later run on a project without a root package.json keeps the tab (desktop)", async ({ page }) => {
    test.setTimeout(150_000);
    const errors = collectConsoleErrors(page);
    await stubSandbox(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    // Only index.html: every run here looks like a first build.
    const build = await startFirstBuild(page, "e2e-preview-auto-open-static");

    try {
      await page.goto(`/projects/${build.projectId}`);
      const previewTab = page.getByRole("tab", { name: "Preview" });
      const codeTab = page.getByRole("tab", { name: "Code" });
      await expect(previewTab).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
      await build.run.complete();
      await page.waitForTimeout(2_000);

      await codeTab.click();
      const second = await build.startRun();
      await page.waitForTimeout(3_000);
      await expect(codeTab).toHaveAttribute("aria-selected", "true");
      await second.complete();
      await page.waitForTimeout(2_000);
      await expect(codeTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await build.cleanup();
    }

    expect(errors).toEqual([]);
  });

  test("offers the preview in a toast on phones", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const errors = collectConsoleErrors(page);
    await stubSandbox(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    const build = await startFirstBuild(page, "e2e-preview-auto-open-phone");

    try {
      await page.goto(`/projects/${build.projectId}`);
      const chatTab = page.getByRole("tab", { name: "Chat" });
      await expect(chatTab).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
      // The file tree is out of the accessibility tree behind the chat; give the files a moment to load.
      await page.waitForTimeout(5_000);
      await build.writePackageJson();
      await page.waitForTimeout(2_000);

      await build.run.complete();
      const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Preview ready" });
      await expect(toast).toBeVisible({ timeout: 30_000 });
      await expect(chatTab).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(500); // enter animation
      await page.screenshot({ path: testInfo.outputPath("toast-phone.png") });

      await toast.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('iframe[title="Preview"]')).toBeVisible();
      await expect(toast).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath("opened-phone.png") });
    } finally {
      await build.cleanup();
    }

    expect(errors).toEqual([]);
  });
});
