// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
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
    });
  });

  test("rejects another user's project", async () => {
    const { t, bob } = setup();
    const { projectId } = await seedProject(t);

    await expect(
      bob.query(api.conversations.getActiveRun, { projectId }),
    ).rejects.toThrow("Unauthorized");
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
