import { expect, test } from "@playwright/test";

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

test("the admin sees the model catalog", async ({ page }) => {
  // The Convex deployment's ADMIN_EMAIL must be this verified Clerk test user.
  const adminEmail = process.env.E2E_ADMIN_EMAIL;
  test.skip(!hasClerkCredentials() || !adminEmail, "Needs Clerk secrets and E2E_ADMIN_EMAIL");
  await addTestingToken(page);
  const admin = await ensureTestUser(adminEmail);
  await revokeStaleSessions(admin.id);
  await signInWithTicket(page, admin.id);

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
