import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";

const ENDPOINT = "/api/ai-providers";

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
