import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const ENDPOINT = "/api/ai-providers";
const SETTINGS_PATH = "/settings/ai-providers";

const horizontalOverflow = () =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth;

/**
 * A stand-in OpenAI-compatible API that accepts one key. `next dev` allows a
 * localhost custom endpoint, so the good-key path needs no real provider.
 */
const startStubProvider = async (apiKey: string) => {
  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${apiKey}`;
    response.writeHead(authorized ? 200 : 401, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(authorized ? { data: [] } : { error: "bad key" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
};

test("POST /api/ai-providers signed out returns 401 JSON", async ({ request }) => {
  const response = await request.post(ENDPOINT, {
    data: { provider: "openai", apiKey: "sk-anything" },
  });
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

/**
 * Serial because the 5/min limit is per user: every POST here counts toward
 * it, so the rate-limit test sends exactly as many as are left in the window.
 */
test.describe.serial("BYOK key storage (signed in)", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const LIMIT = 5;
  let attempts = 0;
  let page: Page;

  const post = (data: Record<string, unknown>) => {
    attempts += 1;
    return page.request.post(ENDPOINT, { data });
  };

  const listKeys = async () =>
    (await userConvexClient(page)).query(api.aiProviders.list, {});

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);

    // Start from no keys, as a new user would.
    const client = await userConvexClient(page);
    for (const key of await client.query(api.aiProviders.list, {})) {
      await client.mutation(api.aiProviders.remove, { keyId: key._id });
    }
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a key the provider rejects returns 400 and stores nothing", async () => {
    const before = await listKeys();

    const response = await post({
      provider: "openai",
      apiKey: "sk-codenaya-e2e-invalid-key-0000",
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(await listKeys()).toHaveLength(before.length);
  });

  test("a good key returns only its last four characters", async () => {
    const apiKey = process.env.E2E_OPENAI_KEY;
    test.skip(
      !apiKey,
      "Needs E2E_OPENAI_KEY (a working OpenAI key) and CODENAYA_LOCAL_KEK on the server",
    );

    const response = await post({ provider: "openai", apiKey, label: "e2e" });
    const text = await response.text();

    expect(response.status()).toBe(200);
    expect(text).not.toContain(apiKey!);
    const body = JSON.parse(text);
    expect(body.maskedPreview).toBe(`••••${apiKey!.slice(-4)}`);

    const keys = await listKeys();
    expect(JSON.stringify(keys)).not.toContain(apiKey!);
    await (await userConvexClient(page)).mutation(api.aiProviders.remove, {
      keyId: body.keyId,
    });
  });

  test("settings tab: an invalid key fails inline and adds no card", async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(SETTINGS_PATH);

    await expect(page.getByText("No API keys yet")).toBeVisible();
    await expect(
      page.getByText("Using your own key consumes no Codenaya credits"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add key" }).click();
    const dialog = page.getByRole("dialog", { name: "Add an API key" });
    await dialog.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "OpenAI", exact: true }).click();
    await dialog.getByLabel("API key").fill("sk-codenaya-e2e-invalid-key-0000");
    attempts += 1;
    await dialog.getByRole("button", { name: "Add key" }).click();

    await expect(dialog.getByRole("alert")).toHaveText(/rejected the API key/);
    expect(await page.evaluate(horizontalOverflow)).toBe(0);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("No API keys yet")).toBeVisible();
  });

  test("settings tab: add, test, set as default and delete a custom key", async () => {
    test.setTimeout(90_000);
    const apiKey = `sk-e2e-stub-${Date.now()}-wxyz`;
    const stub = await startStubProvider(apiKey);
    const errors = collectConsoleErrors(page);

    try {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(SETTINGS_PATH);

      await page.getByRole("button", { name: "Add key" }).click();
      const dialog = page.getByRole("dialog", { name: "Add an API key" });
      await dialog.getByRole("combobox", { name: "Provider" }).click();
      await page.getByRole("option", { name: /Custom/ }).click();
      await dialog.getByLabel("Base URL").fill(stub.baseUrl);
      await dialog.getByLabel("Model ids").fill("stub-model");
      await dialog.getByLabel("API key").fill(apiKey);
      await dialog.getByLabel("Label (optional)").fill("E2E stub");
      expect(await page.evaluate(horizontalOverflow)).toBe(0);
      attempts += 1;
      await dialog.getByRole("button", { name: "Add key" }).click();
      await expect(dialog).toBeHidden();

      const card = page.getByRole("listitem", { name: "E2E stub" });
      await expect(card).toContainText(`••••${apiKey.slice(-4)}`);
      await expect(card).toContainText("Active");
      expect(await page.content()).not.toContain(apiKey);
      expect(await page.evaluate(horizontalOverflow)).toBe(0);

      // Test re-checks the key and records when.
      const client = await userConvexClient(page);
      const testedAt = async () =>
        (await client.query(api.aiProviders.list, {})).find(
          (key) => key.label === "E2E stub",
        )?.lastTestedAt ?? 0;
      const before = await testedAt();
      await card.getByRole("button", { name: "Test" }).click();
      // Generous: `next dev` compiles the test route on first use.
      await expect(page.getByText("E2E stub is working")).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(testedAt).toBeGreaterThan(before);

      // The default model is stored in Convex, so it survives a reload.
      const modelSelect = page.getByRole("combobox", { name: "Default model" });
      await modelSelect.click();
      await page.getByRole("option", { name: "stub-model" }).click();
      await expect(page.getByText(/consume no Codenaya credits/)).toBeVisible();
      await page.reload();
      await expect(modelSelect).toHaveText("stub-model");

      await card.getByRole("button", { name: "Delete E2E stub" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(card).toBeHidden();
      await expect(page.getByText("No API keys yet")).toBeVisible();
      // Deleting the default key returns runs to Codenaya's models.
      await expect(page.getByText(/consume Codenaya credits/)).toBeVisible();

      expect(errors).toEqual([]);
    } finally {
      stub.server.close();
    }
  });

  test("the 6th POST within a minute returns 429", async () => {
    // Invalid bodies are rejected after the limit check, without calling out.
    while (attempts < LIMIT) {
      expect((await post({})).status()).toBe(400);
    }
    const response = await post({});
    expect(response.status()).toBe(429);
    expect(response.headers()["retry-after"]).toBeTruthy();
  });
});
