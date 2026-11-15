import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ensureTestUser, hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { injectPreviewBridge } from "../src/features/sandbox-preview/utils/preview-bridge";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

/**
 * Stubs the sandbox so the boot resolves once `ready` does (at once by default),
 * after any `output` lines; returns the boot request count.
 */
const stubSandbox = async (
  page: Page,
  output: string[] = [],
  previewUrl = "about:blank",
  ready: Promise<unknown> = Promise.resolve(),
) => {
  const counter = { boots: 0 };
  await page.route("**/api/sandbox", async (route) => {
    counter.boots += 1;
    await ready;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: [
        ...output.map((data) => ({ type: "output", data })),
        { type: "ready", sandboxId: "e2e-sandbox", previewUrl },
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
      checkBuildDone: () => system.mutation(api.system.upsertMessageSteps, {
        internalKey, messageId,
        steps: [{ id: "checked", kind: "tool", tool: "checkBuild", status: "done", startedAt: Date.now(), endedAt: Date.now() }],
      }),
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
    writeFile: async (name: string, content = `${name}\n`) => {
      await system.mutation(api.system.createFile, { internalKey, projectId, name, content });
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

  test("a stubbed bridge pick adds a chip and opens compact Chat (#227)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 768, height: 1024 });
    await signIn(page);
    const previewUrl = new URL("/__e2e-select-preview", page.url()).href;
    await page.route(previewUrl, (route) => route.fulfill({
      contentType: "text/html",
      body: `<html><body><button>Save</button><script>
        addEventListener('message', (event) => {
          if (event.source !== parent || event.data.kind !== 'select:on') return;
          parent.postMessage({ source: 'codenaya-preview', version: 1, kind: 'select:picked', element: {
            tag: 'button', text: 'Save', domPath: 'body > button', outerHTML: '<button>Save</button>',
            rect: { x: 0, y: 0, width: 50, height: 30 }
          } }, '*');
        });
      </script></body></html>`,
    }));
    await stubSandbox(page, [], previewUrl);
    const build = await startFirstBuild(page, "e2e-preview-select");
    try {
      await page.goto(`/projects/${build.projectId}`);
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
      await build.writePackageJson();
      await build.run.complete();
      await page.getByRole("tab", { name: "Preview" }).click();
      const select = page.getByRole("button", { name: "Select element", exact: true });
      await expect(select).toBeEnabled({ timeout: 30_000 });
      await expect(page.frameLocator('iframe[title="Preview"]').getByRole("button", { name: "Save" })).toBeVisible();
      await select.click();
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("button", { name: 'Remove <button> "Save"', exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Preview" }).click();
      await expect(select).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByRole("alert").filter({ hasText: "Runtime error" })).toHaveCount(0);
    } finally {
      await build.cleanup();
    }
  });

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

  for (const startupRefreshed of [false, true]) {
    test(`reloads the finished first build in a visible tab (startup refresh ${startupRefreshed ? "done" : "pending"}, #561)`, async ({ page }) => {
      test.setTimeout(150_000);
      await signIn(page);
      const previewUrl = new URL("/__e2e-first-build-preview", page.url()).href;
      let heading = "App";
      let loads = 0;
      // Serve the current app on navigation, with no HMR connection.
      await page.route(previewUrl, (route) => {
        loads += 1;
        return route.fulfill({ contentType: "text/html", body: `<h1>${heading}</h1>` });
      });
      await stubSandbox(page, [], previewUrl);
      await page.setViewportSize({ width: 1440, height: 900 });
      const build = await startFirstBuild(page, `e2e-preview-first-build-reload-${startupRefreshed}`);

      try {
        await page.clock.install();
        await page.goto(`/projects/${build.projectId}`);
        await expect(page.getByRole("status", { name: "Building your app" })).toBeVisible({ timeout: 60_000 });
        await page.clock.pauseAt(Date.now() + 1_000);
        expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
        await build.writePackageJson();
        await expect.poll(async () => {
          await page.clock.runFor(500);
          return loads;
        }, { timeout: 30_000 }).toBe(1);
        const app = page.frameLocator('iframe[title="Preview"]').getByRole("heading");
        await expect(app).toHaveText("App", { timeout: 30_000 });
        // Cover completion both before and after the startup refresh fires.
        if (startupRefreshed) {
          await page.clock.runFor(2_500);
          await expect.poll(() => loads).toBe(2);
        }
        const beforeCompletion = loads;
        await build.writeFile("App.tsx", 'export default function App() { return <h1>Booking page</h1>; }');
        heading = "Booking page";
        await expect(app).toHaveText("App");
        await build.run.complete();
        await expect(page.getByRole("status", { name: "Still building" })).toBeHidden();
        await page.clock.runFor(2_500);
        await expect(app).toHaveText("Booking page");
        // One reload: a pending startup refresh folds into the end-of-build one.
        expect(loads).toBe(beforeCompletion + 1);

        // Completing a follow-up run must not reload the app.
        const second = await build.startRun();
        await expect(page.getByText("Agent working")).toBeVisible();
        await second.complete();
        await expect(page.getByText("Agent working")).toBeHidden();
        await page.clock.runFor(3_000);
        expect(loads).toBe(beforeCompletion + 1);
      } finally {
        await build.cleanup();
      }
    });
  }

  test("reloads a failed document once after a checked repair's final sync, without HMR (#774)", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const previewUrl = new URL("/__e2e-repair-preview", page.url()).href;
    let available = true;
    let loads = 0;
    await page.route(previewUrl, (route) => {
      loads++;
      return route.fulfill({ status: available ? 200 : 502, contentType: "text/html", body: available ? "<h1>Bright Smile</h1>" : "" });
    });
    await stubSandbox(page, [], previewUrl);
    let holdSync = false;
    let syncing = false;
    let finishSync = () => {};
    const sync = new Promise<void>((resolve) => { finishSync = resolve; });
    await page.route("**/api/sandbox/**", async (route) => {
      if (holdSync && route.request().method() === "PATCH") {
        syncing = true;
        await sync;
      }
      return route.fulfill({ json: {} });
    });
    const build = await startFirstBuild(page, "e2e-preview-repair-reload");
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/projects/${build.projectId}`);
      await build.writePackageJson();
      const app = page.frameLocator('iframe[title="Preview"]').getByRole("heading");
      await expect(app).toHaveText("Bright Smile", { timeout: 60_000 });
      await build.run.complete();
      await expect(page.getByRole("status", { name: "Still building" })).toBeHidden();
      await page.waitForTimeout(4_000);
      available = false;
      await page.getByRole("button", { name: "Refresh page", exact: true }).click();
      await expect(app).toHaveCount(0);
      const beforeRepair = loads;
      const repair = await build.startRun();
      await expect(page.getByText("Agent working")).toBeVisible();
      holdSync = true;
      await build.writeFile("repaired.txt");
      await expect.poll(() => syncing).toBe(true);
      await repair.checkBuildDone();
      await repair.complete();
      await expect(page.getByText("Agent working")).toBeHidden();
      await page.waitForTimeout(1500);
      expect(loads).toBe(beforeRepair);
      available = true;
      finishSync();
      await expect(app).toHaveText("Bright Smile");
      await page.waitForTimeout(4_000);
      expect(loads).toBe(beforeRepair + 1);
    } finally {
      finishSync();
      await build.cleanup();
    }
  });

  test("a first build that ends while the sandbox boots reloads once, via the startup refresh (#561)", async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const previewUrl = new URL("/__e2e-first-build-booting", page.url()).href;
    let loads = 0;
    await page.route(previewUrl, (route) => {
      loads += 1;
      return route.fulfill({ contentType: "text/html", body: "<h1>App</h1>" });
    });
    let boot = () => {};
    const sandbox = await stubSandbox(page, [], previewUrl, new Promise<void>((resolve) => (boot = resolve)));
    await page.setViewportSize({ width: 1440, height: 900 });
    const build = await startFirstBuild(page, "e2e-preview-first-build-booting");

    try {
      await page.goto(`/projects/${build.projectId}`);
      await expect(page.getByRole("status", { name: "Building your app" })).toBeVisible({ timeout: 60_000 });
      await build.writePackageJson();
      await expect.poll(() => sandbox.boots, { timeout: 30_000 }).toBe(1);
      // The run ends mid-boot: nothing to reload yet.
      await build.run.complete();
      await page.waitForTimeout(2_000);
      boot();
      // The boot's load, then its startup refresh, and nothing more.
      await expect.poll(() => loads, { timeout: 30_000 }).toBe(2);
      await page.waitForTimeout(5_000);
      expect(loads).toBe(2);
    } finally {
      await build.cleanup();
    }
  });

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

  for (const kind of ["runtime", "build"] as const) {
    test(`covers a later run's ${kind} error across clears, then reveals a persistent error`, async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page);
      const previewUrl = new URL(`/__e2e-transient-${kind}`, page.url()).href;
      let loads = 0;
      await page.route(previewUrl, (route) => {
        loads += 1;
        return route.fulfill({
          contentType: "text/html",
          body: injectPreviewBridge("<html><head></head><body><h1>App</h1></body></html>"),
        });
      });
      await stubSandbox(page, [], previewUrl);
      const sent: string[] = [];
      await page.route("**/api/messages", (route) => {
        sent.push((route.request().postDataJSON() as { message: string }).message);
        return route.fulfill({ status: 200, json: {} });
      });
      const build = await startFirstBuild(page, `e2e-preview-transient-${kind}`);
      try {
        await build.writePackageJson();
        await build.run.complete();
        await page.goto(`/projects/${build.projectId}?view=preview`);
        await expect.poll(() => loads, { timeout: 60_000 }).toBe(2);
        const iframe = page.locator('iframe[title="Preview"]');
        const building = page.getByRole("status", { name: "Building your app" });
        const fixing = page.getByRole("status", { name: "Fixing an error" });
        const banner = page.getByRole("alert").filter({ hasText: "Transient edit failure" });
        const report = (messageKind: string) =>
          page.frameLocator('iframe[title="Preview"]').locator("body").evaluate((_, kind) => {
            parent.postMessage({ source: "codenaya-preview", version: 1, kind, message: "Transient edit failure" }, "*");
          }, messageKind);

        // An idle preview's error remains actionable.
        await report(kind);
        await expect(banner).toBeVisible();
        await expect(building).toBeHidden();
        const repair = await build.startRun();
        await expect(building).toBeVisible();
        await expect(banner).toHaveCount(0);
        await expect(iframe).toHaveAttribute("inert", "");
        // File edits and new-page signals clear errors mid-run; keep the cover latched.
        await report("page");
        await build.writeFile("repair.txt");
        await page.waitForTimeout(1000);
        await expect(building).toBeVisible();
        await report(kind);
        await repair.complete();
        // Run end releases this cover and hands the error to the existing auto-fix.
        await expect(building).toBeHidden();
        await expect(fixing).toBeVisible();
        await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(1);
        const fix = await build.startRun();
        // Let the active-run subscription observe the stubbed fix before completing it.
        await page.waitForTimeout(5000);
        await fix.complete();
        await expect(banner).toBeVisible({ timeout: 30_000 });
        await expect(building).toBeHidden();
        await expect(fixing).toBeHidden();
        await expect(iframe).not.toHaveAttribute("inert");
        await expect(banner.getByRole("button", { name: "Fix with AI" })).toBeEnabled();
        expect(sent).toHaveLength(1);
      } finally {
        await build.cleanup();
      }
    });
  }

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
      await expect(page.getByRole("button", { name: "Refresh page", exact: true })).toBeEnabled({ timeout: 30_000 });
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

  for (const healed of [true, false]) {
    test(`reloads a first build's runtime error once before any fix (${healed ? "gone" : "still there"}, #486)`, async ({ page }) => {
      test.setTimeout(180_000);
      await signIn(page);
      // Same origin as the IDE, so the bridge's messages pass the origin check.
      const previewUrl = new URL("/__e2e-486-preview", page.url()).href;
      let broken = true;
      let loads = 0;
      await page.route(previewUrl, (route) => {
        loads += 1;
        // Like the e2b proxy: the bridge goes first, then the app, which throws
        // while it runs two React copies.
        const app = broken ? "<script>throw new Error('Two Reacts')</script>" : "";
        return route.fulfill({
          contentType: "text/html",
          body: injectPreviewBridge(`<html><head></head><body><h1>App</h1>${app}</body></html>`),
        });
      });
      await stubSandbox(page, [], previewUrl);
      // Stubbed, so no agent run (or model spend) starts.
      const sent: string[] = [];
      await page.route("**/api/messages", (route) => {
        sent.push((route.request().postDataJSON() as { message: string }).message);
        return route.fulfill({ status: 200, json: {} });
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      const build = await startFirstBuild(page, `e2e-preview-486-reload-${healed}`);

      try {
        await page.goto(`/projects/${build.projectId}`);
        await expect(page.getByRole("status", { name: "Building your app" })).toBeVisible({ timeout: 60_000 });
        await build.writePackageJson();
        // The boot's load and its startup refresh, both broken: the card covers them.
        await expect.poll(() => loads, { timeout: 30_000 }).toBe(2);
        await page.waitForTimeout(1_000);
        expect(loads).toBe(2);
        await expect(page.getByRole("status", { name: "Building your app" })).toBeVisible();

        broken = !healed;
        await build.run.complete();
        // One reload against the finished files, before the auto-fix.
        await expect.poll(() => loads, { timeout: 10_000 }).toBe(3);
        if (healed) {
          await expect(page.frameLocator('iframe[title="Preview"]').getByRole("heading")).toHaveText("App");
          await page.waitForTimeout(6_000);
          expect(sent).toHaveLength(0);
          await expect(page.getByRole("alert").filter({ hasText: "Two Reacts" })).toHaveCount(0);
        } else {
          // Reported again by the new page: still fixed, once.
          await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(1);
          expect(sent[0]).toContain("Two Reacts");
        }
        // Exactly one reload for the first build's end, and no loop.
        await page.waitForTimeout(5_000);
        expect(loads).toBe(3);
      } finally {
        await build.cleanup();
      }
    });
  }

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
