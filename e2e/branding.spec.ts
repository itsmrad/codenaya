import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const PAGES = [
  { name: "landing", path: "/", url: /\/$/ },
  { name: "404", path: "/this-page-does-not-exist", url: /\/this-page-does-not-exist$/ },
  // Signed out, this redirects to sign-in after the page loads.
  { name: "project", path: "/projects/k57abc123def456ghi789jkl0mn1pqr2", url: /\/sign-in\?/ },
] as const;

/** Computed font of the first `selector` match, once web fonts have loaded. */
const fontOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(async (element) => {
    await document.fonts.ready;
    return getComputedStyle(element).fontFamily;
  });

test.describe("typography", () => {
  for (const viewport of VIEWPORTS) {
    test(`applies Inter and IBM Plex Mono on ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
      // Three pages per test; the first visit compiles each route in dev.
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);

      for (const { name, path, url } of PAGES) {
        await page.goto(path);
        // Let redirects finish, or they abort the next navigation.
        await expect(page).toHaveURL(url);

        await expect
          .poll(() => fontOf(page, "body"), { message: `body font on ${name}` })
          .toMatch(/^"?Inter/);
      }

      await page.goto("/");
      await expect.poll(() => fontOf(page, ".font-mono")).toMatch(/^"?IBM Plex Mono/);
    });
  }
});

test.describe("branding meta", () => {
  test("ships the Codenaya icon, Open Graph, Twitter card and theme color", async ({ page, request }) => {
    await page.goto("/");

    const content = (selector: string) =>
      page.locator(selector).first().getAttribute("content");

    expect(await content('meta[property="og:title"]')).toContain("Codenaya");
    expect(await content('meta[name="twitter:card"]')).toBe("summary_large_image");
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);

    const ogImage = await content('meta[property="og:image"]');
    expect(ogImage).toBeTruthy();
    const ogResponse = await request.get(new URL(ogImage!).pathname);
    expect(ogResponse.status()).toBe(200);

    const iconHref = await page
      .locator('link[rel="icon"]')
      .first()
      .getAttribute("href");
    expect(iconHref).toContain("icon.svg");
    const iconResponse = await request.get(iconHref!);
    expect(iconResponse.status()).toBe(200);
    expect(await iconResponse.text()).toContain("<svg");

    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  });
});
