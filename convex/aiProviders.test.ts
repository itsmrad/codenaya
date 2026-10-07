// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";
const INTERNAL_KEY = "test-internal-key";

const SEALED = {
  secretRef: "ref-1",
  kekProvider: "local",
  kekKeyId: "k1",
  wrappedDek: "dek",
  ciphertext: "ct",
  iv: "iv",
  authTag: "tag",
};

const SUMMARY_KEYS = [
  "_id",
  "provider",
  "label",
  "baseUrl",
  "modelIds",
  "maskedPreview",
  "status",
  "lastTestedAt",
];

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

const createKey = (
  t: TestConvex,
  userId: string,
  overrides: Partial<Parameters<typeof t.mutation<typeof api.system.createAiProviderKey>>[1]> = {},
) =>
  t.mutation(api.system.createAiProviderKey, {
    internalKey: INTERNAL_KEY,
    userId,
    provider: "openai",
    label: "Work key",
    maskedPreview: "••••1234",
    ...SEALED,
    ...overrides,
  });

const as = (t: TestConvex, userId: string) => t.withIdentity({ subject: userId });

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("aiProviders", () => {
  test("list returns only the allowlisted fields, never sealed material", async () => {
    const t = setup();
    await createKey(t, ALICE, {
      provider: "custom",
      baseUrl: "https://llm.example.com/v1",
      modelIds: ["llama-4"],
    });
    await createKey(t, BOB);

    const keys = await as(t, ALICE).query(api.aiProviders.list, {});
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]).sort()).toEqual([...SUMMARY_KEYS].sort());
    expect(keys[0]).toMatchObject({
      provider: "custom",
      maskedPreview: "••••1234",
      status: "active",
    });
    const serialized = JSON.stringify(keys);
    for (const field of ["ciphertext", "wrappedDek", "secretRef", "authTag", "userId"]) {
      expect(serialized).not.toContain(field);
    }
  });

  test("requires a signed-in user", async () => {
    const t = setup();
    await expect(t.query(api.aiProviders.list, {})).rejects.toThrow(/Unauthorized/);
  });

  test("system functions require the internal key", async () => {
    const t = setup();
    await expect(createKey(t, ALICE, { internalKey: "wrong" })).rejects.toThrow();
  });

  test("setPreferences accepts only owned keys and that provider's models", async () => {
    const t = setup();
    const aliceKey = await createKey(t, ALICE);
    const bobKey = await createKey(t, BOB);
    const alice = as(t, ALICE);

    expect(await alice.query(api.aiProviders.getPreferences, {})).toEqual({
      defaultKeyId: null,
      defaultModelId: "openai/gpt-5.6-luna",
    });

    await expect(
      alice.mutation(api.aiProviders.setPreferences, {
        defaultKeyId: bobKey,
        defaultModelId: "gpt-5.6-luna",
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      alice.mutation(api.aiProviders.setPreferences, {
        defaultKeyId: aliceKey,
        defaultModelId: "claude-opus-5-5",
      }),
    ).rejects.toThrow(/not available/);
    await expect(
      alice.mutation(api.aiProviders.setPreferences, { defaultModelId: "gpt-5.6-luna" }),
    ).rejects.toThrow(/not available/);

    await alice.mutation(api.aiProviders.setPreferences, {
      defaultKeyId: aliceKey,
      defaultModelId: "gpt-5.6-luna",
    });
    expect(await alice.query(api.aiProviders.getPreferences, {})).toEqual({
      defaultKeyId: aliceKey,
      defaultModelId: "gpt-5.6-luna",
    });
  });

  test("remove deletes only owned keys and resets a default that used it", async () => {
    const t = setup();
    const aliceKey = await createKey(t, ALICE);
    const bobKey = await createKey(t, BOB);
    const alice = as(t, ALICE);

    await expect(
      alice.mutation(api.aiProviders.remove, { keyId: bobKey }),
    ).rejects.toThrow(/not found/);

    await alice.mutation(api.aiProviders.setPreferences, {
      defaultKeyId: aliceKey,
      defaultModelId: "gpt-5.6-luna",
    });
    await alice.mutation(api.aiProviders.remove, { keyId: aliceKey });

    expect(await alice.query(api.aiProviders.list, {})).toEqual([]);
    expect(await alice.query(api.aiProviders.getPreferences, {})).toEqual({
      defaultKeyId: null,
      defaultModelId: "openai/gpt-5.6-luna",
    });
    expect(await as(t, BOB).query(api.aiProviders.list, {})).toHaveLength(1);
  });

  test("sealed reads are scoped to the key owner", async () => {
    const t = setup();
    const aliceKey = await createKey(t, ALICE);
    const [aliceProject, bobProject] = await t.run(async (ctx) => [
      await ctx.db.insert("projects", { name: "a", ownerId: ALICE, updatedAt: 0 }),
      await ctx.db.insert("projects", { name: "b", ownerId: BOB, updatedAt: 0 }),
    ]);

    const forRun = (projectId: typeof aliceProject) =>
      t.query(api.system.getAiProviderKeyForRun, {
        internalKey: INTERNAL_KEY,
        keyId: aliceKey,
        projectId,
      });
    expect(((await forRun(aliceProject)) as Doc<"aiProviderKeys">).ciphertext).toBe("ct");
    expect(await forRun(bobProject)).toBeNull();

    const forUser = (userId: string) =>
      t.query(api.system.getAiProviderKeyForUser, {
        internalKey: INTERNAL_KEY,
        keyId: aliceKey,
        userId,
      });
    expect(await forUser(ALICE)).not.toBeNull();
    expect(await forUser(BOB)).toBeNull();

    await expect(
      t.mutation(api.system.updateAiProviderKeyStatus, {
        internalKey: INTERNAL_KEY,
        keyId: aliceKey,
        userId: BOB,
        status: "invalid",
      }),
    ).rejects.toThrow(/not found/);

    await t.mutation(api.system.updateAiProviderKeyStatus, {
      internalKey: INTERNAL_KEY,
      keyId: aliceKey,
      userId: ALICE,
      status: "invalid",
      statusMessage: "OpenAI rejected the API key.",
    });
    expect(await as(t, ALICE).query(api.aiProviders.list, {})).toMatchObject([
      { status: "invalid" },
    ]);
  });

  test("agent runs record the model on the message and mark the key used", async () => {
    const t = setup();
    const keyId = await createKey(t, ALICE);
    const { projectId, conversationId } = await t.mutation(
      api.system.createProjectWithConversation,
      { internalKey: INTERNAL_KEY, projectName: "p", conversationTitle: "New", ownerId: ALICE },
    );

    const runModel = { keyId, modelId: "gpt-5.6-luna", label: "OpenAI · GPT-5.6 Luna" };
    const messageId = await t.mutation(api.system.createMessage, {
      internalKey: INTERNAL_KEY,
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
      runModel,
    });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.runModel).toEqual(runModel);

    const lastUsedAt = () =>
      t.run(async (ctx) => (await ctx.db.get(keyId))?.lastUsedAt ?? null);
    expect(await lastUsedAt()).toBeNull();
    await t.mutation(api.system.markAiProviderKeyUsed, { internalKey: INTERNAL_KEY, keyId });
    expect(await lastUsedAt()).toEqual(expect.any(Number));

    await expect(
      t.mutation(api.system.markAiProviderKeyUsed, { internalKey: "wrong", keyId }),
    ).rejects.toThrow();
  });
});
