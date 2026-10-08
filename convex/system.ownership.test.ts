// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId: ALICE,
      updatedAt: 0,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: 0,
    });
    return { projectId, conversationId };
  });
  return { t, ...ids };
}

describe("system.getOwnedProject", () => {
  test("returns the project to its owner", async () => {
    const { t, projectId } = await setup();

    const project = await t.query(api.system.getOwnedProject, {
      internalKey: INTERNAL_KEY,
      projectId,
      userId: ALICE,
    });

    expect(project?._id).toBe(projectId);
  });

  test("returns null for another user, a missing id and a malformed id alike", async () => {
    const { t, projectId, conversationId } = await setup();
    const missingId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", { name: "Gone", ownerId: ALICE, updatedAt: 0 });
      await ctx.db.delete(id);
      return id;
    });

    for (const [id, userId] of [
      [projectId, BOB],
      [missingId, ALICE],
      ["not-an-id", ALICE],
      // An id from another table must not pass as a project id.
      [conversationId, ALICE],
    ]) {
      const project = await t.query(api.system.getOwnedProject, {
        internalKey: INTERNAL_KEY,
        projectId: id,
        userId,
      });
      expect(project).toBeNull();
    }
  });

  test("returns null for a project that is being deleted", async () => {
    const { t, projectId } = await setup();
    await t.run((ctx) => ctx.db.patch(projectId, { deletingAt: 1 }));

    const project = await t.query(api.system.getOwnedProject, {
      internalKey: INTERNAL_KEY,
      projectId,
      userId: ALICE,
    });

    expect(project).toBeNull();
  });

  test("rejects a wrong internal key", async () => {
    const { t, projectId } = await setup();

    await expect(
      t.query(api.system.getOwnedProject, { internalKey: "nope", projectId, userId: ALICE }),
    ).rejects.toThrow("Invalid internal key");
  });
});

describe("system.getOwnedConversation", () => {
  test("returns the conversation to its project's owner", async () => {
    const { t, conversationId } = await setup();

    const conversation = await t.query(api.system.getOwnedConversation, {
      internalKey: INTERNAL_KEY,
      conversationId,
      userId: ALICE,
    });

    expect(conversation?._id).toBe(conversationId);
  });

  test("returns null for another user and for a malformed id", async () => {
    const { t, conversationId } = await setup();

    for (const [id, userId] of [
      [conversationId, BOB],
      ["not-an-id", ALICE],
    ]) {
      const conversation = await t.query(api.system.getOwnedConversation, {
        internalKey: INTERNAL_KEY,
        conversationId: id,
        userId,
      });
      expect(conversation).toBeNull();
    }
  });
});
