import { expect, test } from "@playwright/test";

import { collectConsoleErrors } from "./console-errors";

test.describe("pricing page (signed out)", () => {
  test("navbar Pricing link opens the plans", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/");

    await page.locator("header").getByRole("link", { name: "Pricing", exact: true }).click();

    // The first visit compiles the page in dev, which can take a while.
    await expect(page).toHaveURL(/\/pricing$/, { timeout: 30_000 });
    const free = page.getByTestId("plan-free");
    const pro = page.getByTestId("plan-pro");
    await expect(free.getByText("300 credits a month")).toBeVisible();
    await expect(pro.getByText("$20", { exact: true })).toBeVisible();
    await expect(pro.getByText("2,000 credits a month")).toBeVisible();
    await expect(page.getByText(/BYOK/).first()).toBeVisible();

    await expect(free.getByRole("link", { name: "Get started" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    const proCta = pro.getByRole("button", { name: "Coming soon" });
    await expect(proCta).toBeVisible();
    await expect(proCta).toBeDisabled();

    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  test("FAQ items expand", async ({ page }) => {
    await page.goto("/pricing");

    const trigger = page.getByRole("button", { name: "What is BYOK?" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/Runs on your key use no credits/)).toBeVisible();
  });

  test("plan cards stack without horizontal scroll at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/pricing");

    const cards = page.locator('[data-testid^="plan-"]');
    await expect(cards).toHaveCount(2);
    const boxes = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const { left, top } = element.getBoundingClientRect();
        return { left: Math.round(left), top: Math.round(top) };
      }),
    );
    expect(boxes[0].left).toBe(boxes[1].left);
    expect(boxes[1].top).toBeGreaterThan(boxes[0].top);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal overflow in px").toBe(0);
  });
});
