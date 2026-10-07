import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-open-tab";
/** Stands in for the E2B host; both the iframe and the new tab are served by a route. */
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
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(layout.viewport);
      const errors = collectConsoleErrors(page);

      // Hold the sandbox boot so the not-ready state can be checked first.
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => (markReady = resolve));
      await page.route("**/api/sandbox", async (route) => {
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
      await page.goto(`/projects/${projectId}`);
      await page.getByRole("tab", { name: "Preview" }).click();

      const pending = page.getByRole("button", { name: "Open in new tab" });
      await expect(pending).toBeDisabled({ timeout: 60_000 });
      await expect(pending.locator("..")).toHaveAttribute(
        "title",
        "Available once the preview is running",
      );

      markReady();
      const link = page.getByRole("link", { name: "Open in new tab" });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await expect(link).toHaveAttribute("href", PREVIEW_URL);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");

      const popupEvent = context.waitForEvent("page");
      await link.click();
      const popup = await popupEvent;
      await expect(popup).toHaveURL(PREVIEW_URL);
      await expect(popup.getByRole("heading", { name: "Hello from the sandbox" })).toBeVisible();

      expect(errors).toEqual([]);
    });
  }
});
