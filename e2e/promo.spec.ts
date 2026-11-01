import { expect, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

const horizontalOverflow = () =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth;

/** The promotion runs until Nov 1 2026 00:00 UTC (ADR 0009). */
test.skip(Date.now() >= Date.UTC(2026, 10, 1), "The GitHub promotion has ended");

test.describe("GitHub promo page", () => {
  for (const width of [375, 1440]) {
    test(`signed out, offers GitHub sign-in that returns here at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors = collectConsoleErrors(page);
      await page.goto("/promo");

      await expect(page.getByRole("heading", { name: /Claude Opus 5.5/ })).toBeVisible();
      const signInLink = page.getByRole("link", { name: "Sign in with GitHub to claim" });
      await expect(signInLink).toHaveAttribute("href", "/sign-in?redirect_url=%2Fpromo");
      await expect(page.getByText("For GitHub accounts at least 365 days old.")).toBeVisible();
      expect(await page.evaluate(horizontalOverflow)).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test.describe("signed in", () => {
    test.skip(
      !hasClerkCredentials(),
      "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );

    test("asks a user without GitHub to connect it, and the claim route agrees", async ({
      page,
    }) => {
      await signIn(page);
      await page.goto("/promo");

      await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Claim free Opus 5.5" })).toHaveCount(0);

      // The pool users have no GitHub account: the server refuses too.
      const res = await page.request.post("/api/promotions/claim");
      expect(res.status()).toBe(400);
      expect(await res.json()).toMatchObject({ code: "github_not_linked" });
    });

    test("the dashboard banner links to the page and stays dismissed", async ({ page }) => {
      await signIn(page);
      await page.goto("/");
      await page.evaluate(() => localStorage.removeItem("codenaya:promo-banner-dismissed"));
      await page.reload();

      const claim = page.getByRole("link", { name: "Claim" });
      await expect(claim).toHaveAttribute("href", "/promo");

      await page.getByRole("button", { name: "Dismiss promotion" }).click();
      await expect(claim).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole("heading", { name: "What will you build?" })).toBeVisible();
      await expect(claim).toHaveCount(0);
    });
  });
});
