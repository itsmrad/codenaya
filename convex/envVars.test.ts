// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { PUBLIC_KEY_PREFIXES } from "../src/features/integrations/env-keys";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ALICE = "user_alice";

async function setup() {
  const t = convexTest(schema, modules);
  const projectId = await t.run((ctx) =>
    ctx.db.insert("projects", { name: "Env test", ownerId: ALICE, updatedAt: 0 }),
  );
  return { t, projectId, alice: t.withIdentity({ subject: ALICE }) };
}

// Deliberately fake fixtures, matching the shared detector's minimum lengths.
const fake = (...parts: string[]) => parts.join("");
const jwt = (role: string) =>
  fake("eyJhbGciOiJIUzI1NiJ9", ".", btoa(JSON.stringify({ role })).replace(/=+$/, ""), ".", "fakeSignature123456");

describe("setPublicEnvVar (#684)", () => {
  test.each(PUBLIC_KEY_PREFIXES)("rejects a secret under %s on insert and update", async (prefix) => {
    const { alice, projectId } = await setup();
    const key = `${prefix}API_KEY`;
    const value = fake("sk", "_test_", "FAKE0123456789abcdef");
    const rejected = {
      data: {
        code: "INVALID_ARGUMENT",
        message: "This looks like a secret key and would be published in the browser bundle. Use a name without a public prefix and store it as a secret instead.",
      },
    };

    await expect(
      alice.mutation(api.envVars.setPublicEnvVar, { projectId, key, value }),
    ).rejects.toMatchObject(rejected);
    expect(await alice.query(api.envVars.listPublicEnvVars, { projectId })).toEqual([]);

    const id = await alice.mutation(api.envVars.setPublicEnvVar, { projectId, key, value: "safe" });
    await expect(
      alice.mutation(api.envVars.setPublicEnvVar, { projectId, key, value }),
    ).rejects.toMatchObject(rejected);
    expect(await alice.query(api.envVars.listEnvVars, { projectId })).toMatchObject([
      { _id: id, key, value: "safe", maskedPreview: "safe", visibility: "public" },
    ]);
  });

  test.each([
    ["Supabase secret", fake("sb", "_secret_", "FAKE0123456789abcdefghij")],
    ["Supabase service role", jwt("service_role")],
    ["Resend", fake("re", "_fake1234_", "FAKE0123456789abcdefghij")],
    ["PostHog personal", fake("phx", "_", "FAKE0123456789abcdefghij")],
    ["Sentry org token", fake("sntrys", "_", "FAKE0123456789abcdefghij")],
    ["Sentry user token", fake("sntryu", "_", "FAKE0123456789abcdefghij")],
    ["password DSN", "postgresql://fake:fakepassword@db.example.com/app"],
  ])("rejects a %s value", async (_label, value) => {
    const { alice, projectId } = await setup();
    await expect(
      alice.mutation(api.envVars.setPublicEnvVar, { projectId, key: "NEXT_PUBLIC_KEY", value }),
    ).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
    expect(await alice.query(api.envVars.listPublicEnvVars, { projectId })).toEqual([]);
  });

  test.each([
    ["Supabase anon JWT", jwt("anon")],
    ["Supabase publishable key", fake("sb", "_publishable_", "FAKE0123456789abcdefghij")],
    ["Clerk publishable key", fake("pk", "_test_", btoa("fake.clerk.accounts.dev$"))],
    ["Stripe publishable key", fake("pk", "_live_", "FAKE0123456789abcdefghij")],
    ["Firebase web key", fake("AIza", "FAKE0123456789abcdefghijklmnopqrstuvwx")],
    ["Sentry DSN", "https://fake123@o0.ingest.sentry.io/0"],
    ["URL", "https://example.supabase.co"],
  ])("stores a %s unchanged", async (_label, value) => {
    const { alice, projectId } = await setup();
    const key = "VITE_KEY";
    await alice.mutation(api.envVars.setPublicEnvVar, { projectId, key, value });
    expect(await alice.query(api.envVars.listPublicEnvVars, { projectId })).toEqual([{ key, value }]);
  });

  test("requires authentication and project ownership", async () => {
    const { t, alice, projectId } = await setup();
    const args = { projectId, key: "NEXT_PUBLIC_URL", value: "https://example.com" };
    await expect(t.mutation(api.envVars.setPublicEnvVar, args)).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
    await expect(
      t.withIdentity({ subject: "user_bob" }).mutation(api.envVars.setPublicEnvVar, args),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await alice.query(api.envVars.listPublicEnvVars, { projectId })).toEqual([]);
  });
});
