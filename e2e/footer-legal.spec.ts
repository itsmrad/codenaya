import { expect, test } from "@playwright/test";

import { collectConsoleErrors } from "./console-errors";

test.describe("footer and legal pages (signed out)", () => {
  for (const name of ["Terms", "Privacy"]) {
    test(`footer "${name}" link opens a page with a heading`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await page.goto("/");

      await page.locator("footer").getByRole("link", { name, exact: true }).click();

      // The first visit compiles the page in dev, which can take a while.
      await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}$`), { timeout: 30_000 });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(errors).toEqual([]);
    });
  }

  test("no internal footer link returns 404", async ({ page, request }) => {
    await page.goto("/");

    const hrefs = await page
      .locator('footer a[href^="/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of new Set(hrefs)) {
      const response = await request.get(href);
      expect(response.status(), href).toBeLessThan(400);
    }
  });

  test("footer columns stack without horizontal scroll at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");

    const columns = page.locator('footer nav[aria-label="Footer"] > div');
    await expect(columns).toHaveCount(3);
    const lefts = await columns.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().left)),
    );
    expect(new Set(lefts).size).toBe(1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal overflow in px").toBe(0);
  });
});
