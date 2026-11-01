import { expect, test } from "@playwright/test";

import { promoModelIds } from "../src/features/ai-providers/catalog";
import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";

const projectId = process.env.E2E_PROJECT_ID;

/** The GitHub promotion ended Nov 1 2026 (ADR 0009): the site no longer offers it. */
test.describe("ended GitHub promo", () => {
  test("its page and claim route are gone, and no public page mentions it", async ({ page }) => {
    expect((await page.goto("/promo"))?.status()).toBe(404);
    expect((await page.request.post("/api/promotions/claim")).status()).toBe(404);

    for (const path of ["/", "/pricing"]) {
      await page.goto(path);
      await expect(page.locator("body")).not.toContainText(/promo/i);
    }
  });

  test.describe("signed in", () => {
    test.skip(
      !hasClerkCredentials() || !projectId,
      "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and E2E_PROJECT_ID",
    );

    test("the dashboard and the picker show no promo", async ({ page }) => {
      await signIn(page);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "What will you build?" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText(/promo/i);

      await page.goto(`/projects/${projectId}?engine=webcontainer`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.getByRole("combobox", { name: "Agent model" }).click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await expect(page.getByRole("group", { name: "Free promotion" })).toHaveCount(0);
      await expect(page.getByRole("listbox")).not.toContainText(/promo|runs left|unlimited/i);
    });

    test("a saved promo pick switches to the default once, with a notice", async ({ page }) => {
      await signIn(page);
      await page.goto("/");
      const catalog = await (await userConvexClient(page)).query(api.platformCatalog.getForUsers, {});
      const [promoId] = catalog ? promoModelIds(catalog.models) : [];
      test.skip(!promoId, "The dev catalog has no promo models to pick");

      await page.evaluate(
        (modelId) => localStorage.setItem("codenaya:agent-model", JSON.stringify({ modelId })),
        promoId,
      );
      await page.goto(`/projects/${projectId}?engine=webcontainer`);

      await expect(page.getByText("The free Claude promotion has ended")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("codenaya:agent-model")))
        .not.toContain(promoId);

      await page.reload();
      await expect(page.getByRole("combobox", { name: "Agent model" })).not.toBeEmpty();
      await expect(page.getByText("The free Claude promotion has ended")).toHaveCount(0);
    });
  });
});
