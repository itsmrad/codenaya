import { expect, type Locator, type Page } from "@playwright/test";

export const COMPOSER_WIDTHS = [375, 768, 1280, 1700];

/**
 * The composer toolbar fits its card: Build stays inside the frame and the mode
 * toggle is no taller than the toolbar's cells (`cell` names one, e.g. Clear).
 */
export const expectToolbarFits = async (scope: Locator, cell: string) => {
  // first(): the landing page also has the CTA composer further down.
  const card = scope.getByTestId("prompt-composer").first();
  await card.getByRole("textbox", { name: "Describe what you want to build" }).fill("a kanban board app");
  await expect(async () => {
    const frame = await card.boundingBox();
    const submit = await card.getByRole("button", { name: "Create project" }).boundingBox();
    const toggle = await card.getByRole("radiogroup", { name: "Message mode" }).boundingBox();
    const reference = await card.getByRole("button", { name: cell }).boundingBox();
    if (!frame || !submit || !toggle || !reference) throw new Error("composer toolbar not rendered");
    expect(submit.x + submit.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
    expect(toggle.height).toBeLessThanOrEqual(reference.height + 2);
  }).toPass({ timeout: 5_000 });
};

/** Runs `expectToolbarFits` at each width in COMPOSER_WIDTHS. */
export const expectToolbarFitsAtWidths = async (page: Page, scope: Locator, cell: string) => {
  for (const width of COMPOSER_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectToolbarFits(scope, cell);
  }
};
