import { expect, test, type Locator } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { getProvider, listVisibleProviders } from "../src/features/integrations/catalog";

const desktop = { width: 1440, height: 900 };
const viewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  desktop,
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A provider's tile in a catalog; its name says Connect, or Manage once connected. */
const providerTile = (scope: Locator, displayName: string) =>
  scope
    .getByRole("list", { name: "Integration providers" })
    .getByRole("button", { name: new RegExp(`^(Connect|Manage) ${escapeRegExp(displayName)}$`) });

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
        await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
        await expect(providers.locator("img")).toHaveCount(listVisibleProviders().length);
        for (const logo of await providers.locator("img").all()) {
          await logo.scrollIntoViewIfNeeded();
          await expect.poll(() => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        await expect(providers.getByText("Read-only capable", { exact: true })).toHaveCount(listVisibleProviders().filter((provider) => provider.supportsReadOnly).length);
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
        if (viewport.width <= 768) await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("button", { name: "Integrations", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
        const providers = dialog.getByRole("list", { name: "Integration providers" });
        await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
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
        await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
        await search.fill("Context7");
        await providers.getByRole("button").click();
        await expect(dialog.getByRole("heading", { name: /^(Add|Manage) Context7$/ })).toBeVisible();
        await dialog.getByRole("button", { name: "Back to provider list" }).click();
        await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
      });
    }
  }

  // Category chips are nowrap; they must scroll inside the dialog, not widen it.
  for (const width of [390, 1024, 1440]) {
    test(`IDE connect dialog stays inside its frame at ${width}px`, async ({ page }) => {
      test.setTimeout(120_000);
      test.skip(!process.env.E2E_PROJECT_ID, "Needs E2E_PROJECT_ID for the EVAL fixture project");
      await page.setViewportSize({ width, height: 720 });
      await page.route("**/api/integrations/**", (route) => route.abort());
      await page.route("**/api/sandbox", (route) => route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl: "about:blank" })}\n`,
      }));
      await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
      await signIn(page);
      await page.goto(`/projects/${process.env.E2E_PROJECT_ID}`);
      if (width <= 768) await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("button", { name: "Integrations", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
      const providers = dialog.getByRole("list", { name: "Integration providers" });
      await expect(providers.getByRole("listitem").first()).toBeVisible();

      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const connect = providerTile(dialog, listVisibleProviders()[0].displayName);
      const edges = await connect.evaluate((element) => {
        const button = element.getBoundingClientRect();
        const frame = element.closest("[role='dialog']")!.getBoundingClientRect();
        return { buttonRight: button.right, dialogRight: frame.right };
      });
      expect(edges.buttonRight).toBeLessThanOrEqual(edges.dialogRight);

      await dialog.evaluate((element) => {
        for (const node of [element, ...element.querySelectorAll<HTMLElement>("*")]) {
          if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        }
      });
      await expect(dialog.getByText("Connect services and link them to this project.")).toBeInViewport({ ratio: 1 });
    });
  }

  test("Settings ?connect= opens that provider; unknown ids show the plain catalog", async ({ page }) => {
    await page.setViewportSize(desktop);
    const errors = collectConsoleErrors(page);
    await page.route("**/api/integrations/**", (route) => route.abort());
    await signIn(page);
    const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });

    await page.goto("/settings/integrations?connect=supabase");
    await expect(dialog.getByRole("heading", { name: /^(Add|Manage) Supabase$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Closing drops the param, so a reload doesn't reopen the dialog.
    await expect(page).toHaveURL(/\/settings\/integrations$/);

    await page.goto("/settings/integrations?connect=not-a-provider");
    const providers = page.getByRole("region", { name: "Browse integrations" }).getByRole("list", { name: "Integration providers" });
    await expect(providers.getByRole("listitem")).toHaveCount(listVisibleProviders().length);
    // Connections load only after hydration, when a valid id would have opened the dialog.
    await expect(page.getByText("Loading connections...")).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("No-sign-in provider connects without credentials", async ({ page }) => {
    await page.setViewportSize(desktop);
    const provider = getProvider("microsoft-learn")!;
    const connectBodies: unknown[] = [];
    await page.route("**/api/integrations/**", (route) => route.abort());
    // Registered last, so it wins over the abort above.
    await page.route("**/api/integrations/connect", (route) => {
      connectBodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          ok: true,
          connectionId: "e2e-connection",
          linkedToProject: false,
          provider: { id: provider.id, displayName: provider.displayName },
          toolCount: 2,
          truncated: false,
          tools: [{ name: "docs_search" }, { name: "docs_fetch" }],
        },
      });
    });
    await signIn(page);
    await page.goto("/settings/integrations");
    await expect(page.getByText("Loading connections...")).toHaveCount(0);

    const tile = providerTile(page.getByRole("region", { name: "Browse integrations" }), provider.displayName);
    await expect(tile.getByText("No sign-in", { exact: true })).toBeVisible();
    await tile.click();

    const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
    const heading = dialog.getByRole("heading", { name: new RegExp(`^(Add|Manage) ${escapeRegExp(provider.displayName)}$`) });
    await expect(heading).toBeVisible();
    // A connection left by an earlier run opens Manage; start a new one from there.
    if ((await heading.textContent())?.startsWith("Manage")) {
      await dialog.getByRole("button", { name: "Add another connection" }).click();
    }
    await expect(dialog.getByText("No sign-in. Connect to verify the public documentation tools.")).toBeVisible();
    await expect(dialog.getByLabel("API key")).toHaveCount(0);
    await expect(dialog.getByLabel("Server URL")).toHaveCount(0);

    await dialog.getByRole("button", { name: `Connect ${provider.displayName}`, exact: true }).click();
    await expect(dialog.getByText(`${provider.displayName} connected — 2 tools available`)).toBeVisible();
    expect(connectBodies).toEqual([{ providerId: provider.id }]);
  });

  test("Read-only capable badge follows supportsReadOnly", async ({ page }) => {
    await page.setViewportSize(desktop);
    const readOnly = listVisibleProviders().find((provider) => provider.supportsReadOnly);
    const readWrite = listVisibleProviders().find((provider) => !provider.supportsReadOnly);
    expect(readOnly, "catalog has a read-only capable provider").toBeDefined();
    expect(readWrite, "catalog has a provider without read-only").toBeDefined();
    await page.route("**/api/integrations/**", (route) => route.abort());
    await signIn(page);
    await page.goto("/settings/integrations");
    const catalog = page.getByRole("region", { name: "Browse integrations" });

    const readOnlyTile = providerTile(catalog, readOnly!.displayName);
    await expect(readOnlyTile.getByText("Read-only capable", { exact: true })).toBeVisible();
    await expect(readOnlyTile).toHaveAccessibleDescription(/Read-only capable/);

    const readWriteTile = providerTile(catalog, readWrite!.displayName);
    await expect(readWriteTile).toBeVisible();
    await expect(readWriteTile.getByText("Read-only capable", { exact: true })).toHaveCount(0);
    await expect(readWriteTile).not.toHaveAccessibleDescription(/Read-only capable/);
  });
});
