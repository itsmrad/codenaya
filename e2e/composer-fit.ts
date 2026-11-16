import { expect, type Locator, type Page } from "@playwright/test";

export const COMPOSER_WIDTHS = [375, 768, 1280, 1700];

/**
 * The composer toolbar fits its card: Build stays inside the frame, the mode
 * toggle is no taller than the toolbar's cells (`cell` names one, e.g. Clear) and sits
 * inside the card, and neither it nor the last tool overlaps the Clear/Build group.
 */
export const expectToolbarFits = async (scope: Locator, cell: string) => {
  // first(): the landing page also has the CTA composer further down.
  const card = scope.getByTestId("prompt-composer").first();
  await expect(card.getByTestId("prompt-composer-framework")).toHaveCount(0);
  await expect(card.getByRole("combobox", { name: "Framework", exact: true })).toHaveCount(0);
  await expect(card.getByRole("combobox", { name: "Dictation language", exact: true })).toHaveCount(0);
  await card.getByRole("textbox", { name: "Describe what you want to build" }).fill("a kanban board app");
  await expect(async () => {
    const frame = await card.boundingBox();
    const submit = await card.getByRole("button", { name: "Create project" }).boundingBox();
    const toggle = await card.getByRole("radiogroup", { name: "Message mode" }).boundingBox();
    // Removing selectors leaves the mode cell directly beside the preceding tool.
    const gapBeforeMode = await card.getByRole("radiogroup", { name: "Message mode" }).evaluate((element) => {
      const cell = element.parentElement!;
      let previous = cell.previousElementSibling;
      while (previous && (getComputedStyle(previous).position === "absolute" || getComputedStyle(previous).display === "none")) {
        previous = previous.previousElementSibling;
      }
      return previous ? cell.getBoundingClientRect().left - previous.getBoundingClientRect().right : 0;
    });
    expect(Math.abs(gapBeforeMode)).toBeLessThanOrEqual(0.5);
    const reference = await card.getByRole("button", { name: cell }).boundingBox();
    // The Clear/Build group (incl. the char count) starts where the tools row must end.
    const actions = await card.getByTestId("prompt-composer-actions").boundingBox();
    const lastTool = await card.getByTestId("prompt-composer-tools").locator(":scope > *").last().boundingBox();
    if (!frame || !submit || !toggle || !reference || !actions || !lastTool) {
      throw new Error("composer toolbar not rendered");
    }
    expect(submit.x + submit.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
    expect(toggle.height).toBeLessThanOrEqual(reference.height + 2);
    expect(toggle.x).toBeGreaterThanOrEqual(frame.x - 0.5);
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(actions.x + 0.5);
    expect(lastTool.x + lastTool.width).toBeLessThanOrEqual(actions.x + 0.5);
  }).toPass({ timeout: 5_000 });
};

/** Runs `expectToolbarFits` at each width in COMPOSER_WIDTHS. */
export const expectToolbarFitsAtWidths = async (page: Page, scope: Locator, cell: string) => {
  for (const width of COMPOSER_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectToolbarFits(scope, cell);
  }
};
