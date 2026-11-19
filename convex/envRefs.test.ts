// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const REF_ID = "ref_0123456789abcdef0123456789abcdef";

// Stand-in ciphertext: Convex never sees a value, only what the Node side sealed.
const sealed = {
  kekProvider: "local",
  kekKeyId: "kek",
  wrappedDek: "dek",
  ciphertext: "ct",
  iv: "iv",
  authTag: "tag",
};

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "A", ownerId: ALICE, updatedAt: 0 });
    const otherProjectId = await ctx.db.insert("projects", { name: "B", ownerId: ALICE, updatedAt: 0 });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 0 });
    const message = { conversationId, projectId, role: "user" as const, content: "hi" };
    const messageId = await ctx.db.insert("messages", message);
    const otherMessageId = await ctx.db.insert("messages", message);
    return { projectId, otherProjectId, messageId, otherMessageId };
  });

  await t.mutation(api.envRefs.createEnvRefs, {
    internalKey: INTERNAL_KEY,
    projectId: ids.projectId,
    ownerId: ALICE,
    messageId: ids.messageId,
    providerId: "supabase",
    toolName: "get_keys",
    refs: [{ refId: REF_ID, visibility: "secret", rule: "supabase-secret", ...sealed }],
  });

  const resolve = (
    overrides: Partial<{ refId: string; projectId: Id<"projects">; ownerId: string; messageId: Id<"messages"> }> = {},
  ) =>
    t.mutation(api.envRefs.resolveEnvRef, {
      internalKey: INTERNAL_KEY,
      refId: REF_ID,
      projectId: ids.projectId,
      ownerId: ALICE,
      messageId: ids.messageId,
      key: "API_KEY",
      ...overrides,
    });

  return { t, resolve, ...ids };
}

describe("envRefs", () => {
  test("resolves only for the project, owner and run that minted it, returning ciphertext only", async () => {
    const { t, resolve, otherProjectId, otherMessageId } = await setup();

    expect(await resolve()).toEqual({ visibility: "secret", keyExists: false, ...sealed });

    expect(await resolve({ projectId: otherProjectId })).toBeNull();
    expect(await resolve({ ownerId: BOB })).toBeNull();
    expect(await resolve({ messageId: otherMessageId })).toBeNull();
    expect(await resolve({ refId: "ref_ffffffffffffffffffffffffffffffff" })).toBeNull();

    const [row] = await t.run((ctx) => ctx.db.query("mcpEnvRefs").collect());
    expect(Object.keys(row)).not.toContain("value");
  });

  test("an expired ref resolves to null and the approvals cron deletes it", async () => {
    const { t, resolve } = await setup();
    const [row] = await t.run((ctx) => ctx.db.query("mcpEnvRefs").collect());
    expect(row.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    await t.run((ctx) => ctx.db.patch(row._id, { expiresAt: Date.now() - 1 }));

    expect(await resolve()).toBeNull();
    await t.mutation(internal.maintenance.pruneMcpApprovals, {});
    expect(await t.run((ctx) => ctx.db.query("mcpEnvRefs").collect())).toEqual([]);
  });

  test("reports whether the target key is already set", async () => {
    const { t, resolve, projectId } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("projectEnvVars", {
        projectId,
        ownerId: ALICE,
        key: "API_KEY",
        visibility: "public",
        plainValue: "x",
        maskedPreview: "x",
        source: "manual",
        updatedAt: 0,
      }),
    );

    expect(await resolve()).toMatchObject({ keyExists: true });
  });

  test("only the project's owner can mint refs, and only with the internal key", async () => {
    const { t, projectId, messageId } = await setup();
    const args = {
      internalKey: INTERNAL_KEY,
      projectId,
      ownerId: ALICE,
      messageId,
      providerId: "supabase",
      toolName: "get_keys",
      refs: [],
    };

    await expect(t.mutation(api.envRefs.createEnvRefs, { ...args, ownerId: BOB })).rejects.toMatchObject({
      data: { code: "FORBIDDEN" },
    });
    await expect(
      t.mutation(api.envRefs.createEnvRefs, { ...args, internalKey: "wrong-key" }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await expect(t.mutation(api.envRefs.resolveEnvRef, {
      internalKey: "wrong-key",
      refId: REF_ID,
      projectId,
      ownerId: ALICE,
      messageId,
      key: "API_KEY",
    })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  });
});
