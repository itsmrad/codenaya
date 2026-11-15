import { expect, test, type Locator } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { listProviders } from "../src/features/integrations/catalog";

const viewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

async function checkCategoryRow(catalog: Locator) {
  const categories = catalog.getByRole("group", { name: "Integration categories" });
  const chips = categories.getByRole("button");
  expect(await chips.evaluateAll((buttons) => new Set(buttons.map((button) => button.getBoundingClientRect().top)).size)).toBe(1);
  const last = chips.last();
  await last.focus();
  await last.press("Enter");
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  const all = categories.getByRole("button", { name: "All", exact: true });
  await all.focus();
  await all.press("Enter");
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(all).toBeInViewport({ ratio: 1 });
}

// Browsing never submits a credential or calls a real MCP provider.
test.describe("integration catalog", () => {
  test.skip(!hasClerkCredentials(), "Needs the Clerk e2e pool and EVAL Convex fixture");

  for (const viewport of viewports) {
    for (const theme of ["light", "dark"]) {
      test(`Settings catalog at ${viewport.width}px in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
        await page.route("**/api/integrations/**", (route) => route.abort());
        await signIn(page);
        await page.goto("/settings/integrations");
        const catalog = page.getByRole("region", { name: "Browse integrations" });
        const providers = catalog.getByRole("list", { name: "Integration providers" });
        await expect(providers.getByRole("listitem")).toHaveCount(listProviders().length);
        await expect(providers.locator("img")).toHaveCount(listProviders().length);
        for (const logo of await providers.locator("img").all()) {
          await logo.scrollIntoViewIfNeeded();
          await expect.poll(() => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        await expect(providers.getByText("Read-only capable", { exact: true })).toHaveCount(listProviders().filter((provider) => provider.supportsReadOnly).length);
        await checkCategoryRow(catalog);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`settings-${viewport.width}-${theme}.png`), fullPage: true });
      });

      test(`IDE catalog at ${viewport.width}px in ${theme}`, async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        test.skip(!process.env.E2E_PROJECT_ID, "Needs E2E_PROJECT_ID for the EVAL fixture project");
        await page.setViewportSize(viewport);
        await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
        await page.route("**/api/integrations/**", (route) => route.abort());
        await page.route("**/api/sandbox", (route) => route.fulfill({
          contentType: "application/x-ndjson",
          body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
        }));
        await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
        await signIn(page);
        await page.goto(`/projects/${process.env.E2E_PROJECT_ID}`);
        await page.getByRole("button", { name: "Integrations", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
        const providers = dialog.getByRole("list", { name: "Integration providers" });
        await expect(providers.getByRole("listitem")).toHaveCount(listProviders().length);
        const connections = dialog.getByRole("button", { name: /^Project and account connections/ });
        if (await connections.count()) {
          await expect(connections).toHaveAttribute("aria-expanded", "true");
          await expect(dialog.getByRole("region", { name: "Project connections" })).toBeVisible();
        }
        await checkCategoryRow(dialog);
        await providers.getByRole("listitem").first().scrollIntoViewIfNeeded();
        await expect(providers.getByRole("listitem").first()).toBeInViewport({ ratio: 1 });
        await expect(dialog.getByText("Nothing to link yet")).toHaveCount(0);
        await expect(dialog.getByText("No connections yet")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`ide-${viewport.width}-${theme}.png`) });

        const search = dialog.getByRole("searchbox", { name: "Search integrations" });
        await search.fill("Postgres");
        const database = dialog.getByRole("button", { name: "Database", exact: true });
        await database.focus();
        await page.keyboard.press("Enter");
        await expect(database).toHaveAttribute("aria-pressed", "true");
        await expect(providers.getByRole("listitem")).toHaveCount(2);
        await search.fill("");
        await dialog.getByRole("button", { name: "All", exact: true }).click();
        await expect(providers.getByRole("listitem")).toHaveCount(listProviders().length);
        await search.fill("Context7");
        await providers.getByRole("button").click();
        await expect(dialog.getByRole("heading", { name: /^(Add|Manage) Context7$/ })).toBeVisible();
        await dialog.getByRole("button", { name: "Back to provider list" }).click();
        await expect(providers.getByRole("listitem")).toHaveCount(listProviders().length);
      });
    }
  }
});
