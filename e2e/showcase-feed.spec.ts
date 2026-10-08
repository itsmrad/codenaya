import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

/** One more than a feed page (12), so "Load more" always has something to add. */
const SEED_COUNT = 13;
const RUN_ID = `feed${Date.now().toString(36)}`;
const seedTitle = (i: number) => `Seed ${RUN_ID} ${String(i).padStart(2, "0")}`;
const NEWEST_SEED = seedTitle(SEED_COUNT - 1);

const cards = (page: Page) => page.locator('main a[href^="/showcase/"]');
const firstCardTitle = (page: Page) => cards(page).first().locator("h3");

test.describe("showcase feed pagination", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  test.describe.configure({ mode: "serial" });

  let ownerPage: Page;
  const projectIds: Id<"projects">[] = [];
  const showcaseIds: Id<"showcaseProjects">[] = [];

  // Publishes freshly created, 0-upvote projects as the pool user: odd seeds
  // in "game", even ones in "tool". Each is removed (with its showcase entry)
  // afterwards.
  test.beforeAll(async ({ browser }) => {
    ownerPage = await browser.newPage();
    await signIn(ownerPage);
    const user = await userConvexClient(ownerPage);
    for (let i = 0; i < SEED_COUNT; i++) {
      const projectId = await user.mutation(api.projects.create, { name: `e2e ${seedTitle(i)}` });
      projectIds.push(projectId);
      const showcaseId = await user.mutation(api.showcase.publish, {
        projectId,
        title: seedTitle(i),
        description: "e2e showcase feed seed",
        techStack: [],
        designStyle: [],
        category: i % 2 ? "game" : "tool",
      });
      showcaseIds.push(showcaseId);
    }

    // "Top" only differs from "New" once something outranks the 0-upvote
    // seeds; upvote the oldest seed if nothing in the showcase has a vote.
    const anon = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const [top] = await anon.query(api.showcase.getTrending, { limit: 1 });
    if (!top || top.upvotes === 0) {
      await user.mutation(api.showcase.vote, { showcaseProjectId: showcaseIds[0], vote: "up" });
    }
  });

  test.afterAll(async () => {
    if (!ownerPage) return;
    const user = await userConvexClient(ownerPage);
    for (const id of projectIds) await user.mutation(api.projects.remove, { id });
    await ownerPage.close();
  });

  test("a new 0-upvote project leads Newest, sort changes the order, Load more appends", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/showcase");

    await expect(firstCardTitle(page)).toHaveText(NEWEST_SEED);
    await expect(cards(page)).toHaveCount(12);

    await page.getByRole("button", { name: "Top", exact: true }).click();
    await expect(firstCardTitle(page)).not.toHaveText(NEWEST_SEED);

    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(firstCardTitle(page)).toHaveText(NEWEST_SEED);

    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => cards(page).count()).toBeGreaterThan(12);

    expect(errors).toEqual([]);
  });

  test("search reaches past the first page and combines with a category filter", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/showcase");

    await page.getByPlaceholder("Search showcase...").fill(RUN_ID);
    await expect(cards(page)).toHaveCount(12);
    await expect(cards(page).locator("h3").filter({ hasNotText: RUN_ID })).toHaveCount(0);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(cards(page)).toHaveCount(SEED_COUNT);
    await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();

    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByText("Game", { exact: true }).click();
    await expect(cards(page)).toHaveCount(Math.floor(SEED_COUNT / 2));

    expect(errors).toEqual([]);
  });

  test("a category filter keeps the chosen sort", async ({ page }) => {
    await page.goto("/showcase");
    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByText("Game", { exact: true }).click();

    // Seeds are the newest projects, so the newest "game" seed leads.
    await expect(firstCardTitle(page)).toHaveText(seedTitle(SEED_COUNT - 2));
    await page.getByRole("button", { name: "Popular", exact: true }).click();
    await expect(page.getByRole("button", { name: "Popular", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(cards(page).first()).toBeVisible();
  });
});
