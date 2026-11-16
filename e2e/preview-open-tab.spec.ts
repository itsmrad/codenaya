import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-open-tab";
/** Stub sandbox content; the popup uses the real owned page with a stubbed polling response. */
const PREVIEW_URL = "https://preview.e2e.test/";

const LAYOUTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  // The chat sidebar leaves the preview pane narrow enough for the icon-only toolbar.
  { name: "narrow pane", viewport: { width: 1000, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

test.describe("preview open in new tab", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  for (const layout of LAYOUTS) {
    test(`is disabled until the sandbox is ready, then opens it (${layout.name})`, async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(120_000);
      await page.setViewportSize(layout.viewport);
      const errors = collectConsoleErrors(page);

      // Hold the sandbox boot so the not-ready state can be checked first.
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => (markReady = resolve));
      let sandboxBoots = 0;
      await page.route("**/api/sandbox", async (route) => {
        sandboxBoots += 1;
        await ready;
        const events = [
          { type: "status", status: "booting" },
          { type: "ready", sandboxId: "sbx-e2e", previewUrl: PREVIEW_URL },
        ];
        // Dev Strict Mode aborts the first boot request; fulfilling it then throws.
        await route
          .fulfill({
            contentType: "application/x-ndjson",
            body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
          })
          .catch(() => {});
      });
      await page.route("**/api/sandbox/*", (route) => route.fulfill({ json: {} }));
      await context.route(`${PREVIEW_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Hello from the sandbox</h1>" }),
      );

      await signIn(page);
      const projectId = await seedPreviewProject(page, PROJECT_NAME);
      const ownerUrl = new URL(`/p/${projectId}/preview`, page.url()).href;
      // Browser boot is stubbed, so there is no server-provider sandbox to discover.
      // Keep the real server-rendered owner page/auth check and supply its client refresh.
      await context.route(`**/api/projects/${projectId}/preview`, route => route.fulfill({
        json: { name: PROJECT_NAME, previewUrl: PREVIEW_URL },
      }));
      await page.goto(`/projects/${projectId}`);
      await page.getByRole("tab", { name: "Preview" }).click();

      const pending = page.getByRole("button", { name: "Open in new tab" });
      await expect(pending).toBeDisabled({ timeout: 60_000 });
      await expect(pending.locator("..")).toHaveAttribute(
        "title",
        "Available once the preview is running",
      );
      const refresh = page.getByRole("button", { name: "Refresh page", exact: true });
      await expect(refresh).toBeDisabled();
      await page.getByRole("button", { name: "Refresh options", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Restart sandbox", exact: true })).toBeDisabled();
      await expect(page.getByRole("menuitemradio", { name: "Cloud sandbox", exact: true })).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");

      markReady();
      const link = page.getByRole("link", { name: "Open in new tab" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await expect(link).toHaveAttribute("href", ownerUrl);
      await expect(page.getByRole("textbox", { name: "Preview address", exact: true })).toHaveValue(ownerUrl);
      await page.getByRole("button", { name: "Open on phone", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Preview URL", exact: true })).toHaveValue(ownerUrl);
      await expect(page.getByRole("link", { name: "Open preview in new tab", exact: true })).toHaveAttribute("href", ownerUrl);
      await page.keyboard.press("Escape");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(refresh).toBeEnabled();

      await expect(page.getByRole("button", { name: "Preview settings", exact: true })).toHaveCount(0);
      await expect(page.getByText("Preview Settings", { exact: true })).toHaveCount(0);
      if (layout.viewport.width === 1440 || layout.viewport.width === 390) {
        await testInfo.attach(`preview-toolbar-${layout.viewport.width}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      }

      const frame = page.getByTitle("Preview", { exact: true });
      await expect(frame).toBeVisible();
      const bootsBeforeRefresh = sandboxBoots;
      await frame.evaluate((el) => el.setAttribute("data-before-refresh", "true"));
      await refresh.click();
      await expect(frame).not.toHaveAttribute("data-before-refresh", "true");
      await expect(page.frameLocator('iframe[title="Preview"]').getByRole("heading", { name: "Hello from the sandbox" })).toBeVisible();
      expect(sandboxBoots).toBe(bootsBeforeRefresh);

      await page.getByRole("button", { name: "Refresh options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Restart sandbox", exact: true }).click();
      await expect.poll(() => sandboxBoots).toBeGreaterThan(bootsBeforeRefresh);
      await expect(refresh).toBeEnabled();

      const popupEvent = context.waitForEvent("page");
      await link.click();
      const popup = await popupEvent;
      await expect(popup).toHaveURL(ownerUrl);
      await expect(popup.frameLocator('iframe[title="Preview"]').getByRole("heading", { name: "Hello from the sandbox" })).toBeVisible({ timeout: 30_000 });
      if (layout.viewport.width === 1440 || layout.viewport.width === 390) {
        await testInfo.attach(`owner-preview-${layout.viewport.width}`, { body: await popup.screenshot(), contentType: "image/png" });
      }

      expect(errors).toEqual([]);
    });
  }
});
