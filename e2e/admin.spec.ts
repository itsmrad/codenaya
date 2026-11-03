import { type Page, expect, test } from "@playwright/test";

import {
  addTestingToken,
  ensureTestUser,
  hasClerkCredentials,
  revokeStaleSessions,
  signIn,
  signInWithTicket,
} from "./clerk-auth";

const NOT_FOUND_HEADING = { level: 1, name: "Page not found" } as const;

// Admin write routes answer anyone but the admin with a 404, before any other check.
const ADMIN_WRITES = [
  { url: "/api/admin/catalog", data: { models: [], defaultModelId: "x", utilityModelId: "x", confirmRiskyPrices: false } },
  { url: "/api/admin/catalog/test", data: { provider: "openrouter", providerModelId: "x" } },
];

test("/admin is a 404 for signed-out visitors, with no sign-in redirect", async ({ page }) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", NOT_FOUND_HEADING)).toBeVisible();
});

test("admin API routes are a 404 when signed out", async ({ request }) => {
  expect((await request.get("/api/admin/models")).status()).toBe(404);
  for (const { url, data } of ADMIN_WRITES) {
    expect((await request.post(url, { data })).status(), url).toBe(404);
  }
});

test("/admin is a 404 for a signed-in user who isn't the admin", async ({ page }) => {
  test.skip(!hasClerkCredentials(), "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  await signIn(page);

  const page404 = await page.goto("/admin");
  expect(page404?.status()).toBe(404);
  await expect(page.getByRole("heading", NOT_FOUND_HEADING)).toBeVisible();
  const api404 = await page.request.get("/api/admin/models");
  expect(api404.status()).toBe(404);
  for (const { url, data } of ADMIN_WRITES) {
    expect((await page.request.post(url, { data })).status(), url).toBe(404);
  }
});

/** Signs in as the admin, or skips. The Convex deployment's ADMIN_EMAIL must be this verified Clerk test user. */
const signInAsAdmin = async (page: Page) => {
  const adminEmail = process.env.E2E_ADMIN_EMAIL;
  test.skip(!hasClerkCredentials() || !adminEmail, "Needs Clerk secrets and E2E_ADMIN_EMAIL");
  await addTestingToken(page);
  const admin = await ensureTestUser(adminEmail);
  await revokeStaleSessions(admin.id);
  await signInWithTicket(page, admin.id);
};

const switchTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((value) => {
    localStorage.setItem("theme", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: value }));
  }, theme);

test("the admin sees the model catalog", async ({ page }) => {
  await signInAsAdmin(page);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Provider keys" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add models" })).toBeVisible();

  // Even with the admin's session, a write from another origin is refused.
  const crossSite = await page.request.post("/api/admin/catalog/test", {
    data: { provider: "openrouter", providerModelId: "x" },
    headers: { Origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);

  // The section nav renders as a sidebar or as tabs, depending on width.
  await page.getByRole("navigation", { name: "Admin" }).filter({ visible: true }).getByRole("link", { name: "Audit log" }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
});

test("the admin picks Auto's models in the catalog draft (#322)", async ({ page }, testInfo) => {
  await signInAsAdmin(page);
  await page.goto("/admin");

  const list = page.getByRole("list", { name: "Auto models" });
  const card = page.locator('[data-slot="card"]').filter({ has: list });
  const pick = list.getByRole("checkbox", { checked: false, disabled: false }).first();
  await pick.check();
  await expect(pick).toBeChecked();
  const saveBar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(saveBar).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await switchTheme(page, theme);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: testInfo.outputPath(`admin-auto-${theme}-${width}.png`) });
    }
  }

  // Leaves the saved catalog as it was.
  await saveBar.getByRole("button", { name: "Discard" }).click();
  await expect(saveBar).toBeHidden();
});
