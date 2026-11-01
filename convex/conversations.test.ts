// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";

function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: BOB }),
  };
}

type T = ReturnType<typeof convexTest>;

async function seedProject(t: T) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId: ALICE,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: now,
    });
    return { projectId, conversationId };
  });
}

describe("conversations.getActiveRun", () => {
  test("returns null when no run is in flight", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        conversationId,
        projectId,
        role: "assistant",
        content: "Done",
        status: "completed",
      });
    });

    expect(await alice.query(api.conversations.getActiveRun, { projectId })).toBeNull();
  });

  test("returns the processing message's steps", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const step = {
      id: "call_1",
      kind: "tool" as const,
      tool: "createFiles",
      targets: ["package.json"],
      status: "running" as const,
      startedAt: Date.now(),
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        status: "processing",
        steps: [step],
      });
    });

    expect(await alice.query(api.conversations.getActiveRun, { projectId })).toEqual({
      steps: [step],
      firstBuild: false,
    });
  });
});

describe("first build (#338)", () => {
  const INTERNAL_KEY = "test-internal-key";
  const key = { internalKey: INTERNAL_KEY };

  const seededProject = async (t: T) => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
    return await t.mutation(api.system.createProjectWithConversation, {
      ...key,
      projectName: "p",
      conversationTitle: "New",
      ownerId: ALICE,
      firstBuildPending: true,
    });
  };

  const startRun = (t: T, ids: { projectId: Id<"projects">; conversationId: Id<"conversations"> }) =>
    t.mutation(api.system.createMessage, {
      ...key,
      ...ids,
      role: "assistant",
      content: "",
      status: "processing",
    });

  // Each ends its message completed through updateMessageContent, with no
  // files written: a failed dispatch, a rejected key, a plan or a Q&A reply.
  test.each([
    ["a failed dispatch", {}],
    ["a rejected key", {}],
    ["a plan reply", { mode: "plan" as const }],
  ])("stays a first build after %s, until a run writes files", async (_, fields) => {
    const { t, alice } = setup();
    const ids = await seededProject(t);

    const first = await startRun(t, ids);
    await t.run((ctx) => ctx.db.patch(first, fields));
    await t.mutation(api.system.updateMessageContent, { ...key, messageId: first, content: "Not built" });

    const retry = await startRun(t, ids);
    expect(
      await alice.query(api.conversations.getActiveRun, { projectId: ids.projectId }),
    ).toMatchObject({ firstBuild: true });

    await t.mutation(api.projects.completeFirstBuild, { ...key, projectId: ids.projectId });
    await t.mutation(api.system.updateMessageContent, { ...key, messageId: retry, content: "Built" });

    await startRun(t, ids);
    expect(
      await alice.query(api.conversations.getActiveRun, { projectId: ids.projectId }),
    ).toMatchObject({ firstBuild: false });
  });

  test("a project created without the flag is never flagged", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    await t.run((ctx) =>
      ctx.db.insert("messages", { conversationId, projectId, role: "assistant", content: "", status: "processing" }),
    );

    expect(await alice.query(api.conversations.getActiveRun, { projectId })).toMatchObject({
      firstBuild: false,
    });
  });

  test("completeFirstBuild needs the internal key", async () => {
    const { t } = setup();
    const { projectId } = await seededProject(t);

    await expect(
      t.mutation(api.projects.completeFirstBuild, { internalKey: "nope", projectId }),
    ).rejects.toThrow("Invalid internal key");
  });
});

describe("ownership (#354)", () => {
  test("every function refuses another user with FORBIDDEN", async () => {
    const { t, bob } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const forbidden = { data: { code: "FORBIDDEN" } };

    await expect(
      bob.mutation(api.conversations.create, { projectId, title: "Mine now" }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      bob.query(api.conversations.getById, { id: conversationId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      bob.query(api.conversations.getByProject, { projectId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      bob.query(api.conversations.getMessages, { conversationId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      bob.query(api.conversations.getActiveRun, { projectId }),
    ).rejects.toMatchObject(forbidden);
  });

  test("a deleted conversation is NOT_FOUND", async () => {
    const { t, alice } = setup();
    const { conversationId } = await seedProject(t);
    await t.run((ctx) => ctx.db.delete("conversations", conversationId));

    await expect(
      alice.query(api.conversations.getMessages, { conversationId }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});

describe("plan-mode messages (#120)", () => {
  test("a plan reply keeps its mode for the chat", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
    const create = (mode?: "plan") =>
      t.mutation(api.system.createMessage, {
        internalKey: "ik",
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        status: "processing",
        ...(mode ? { mode } : {}),
      });

    const plan = await create("plan");
    const build = await create();

    const messages = await alice.query(api.conversations.getMessages, { conversationId });
    expect(messages.find((m) => m._id === plan)?.mode).toBe("plan");
    expect(messages.find((m) => m._id === build)).not.toHaveProperty("mode");
  });
});
