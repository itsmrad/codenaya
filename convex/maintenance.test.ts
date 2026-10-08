// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  LOST_RUN_MESSAGE,
  LOST_RUN_MS,
} from "../src/features/conversations/agent-steps";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const START = new Date("2026-10-07T12:00:00Z").getTime();
const MINUTE = 60_000;

type Message = Partial<Doc<"messages">>;

/** An assistant message created at START in a fresh project. */
async function seedMessage(t: ReturnType<typeof convexTest>, fields: Message) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "Habit tracker",
      ownerId: "user_alice",
      updatedAt: START,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "New conversation",
      updatedAt: START,
    });
    return await ctx.db.insert("messages", {
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      ...fields,
    });
  });
}

describe("failLostMessageRuns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    return convexTest(schema, modules);
  }

  test("fails a run with no progress for LOST_RUN_MS and closes its running steps", async () => {
    const t = setup();
    const messageId = await seedMessage(t, {
      status: "processing",
      steps: [
        { id: "a", kind: "tool", tool: "createFolder", status: "done", startedAt: START, endedAt: START + MINUTE },
        { id: "b", kind: "tool", tool: "createFiles", status: "running", startedAt: START + 2 * MINUTE },
      ],
    });

    vi.setSystemTime(START + 2 * MINUTE + LOST_RUN_MS);
    const result = await t.mutation(internal.maintenance.failLostMessageRuns, {});

    expect(result).toEqual({ scanned: 1, failed: 1 });
    const message = await t.run((ctx) => ctx.db.get("messages", messageId));
    expect(message).toMatchObject({
      status: "completed",
      content: LOST_RUN_MESSAGE,
      completedAt: START + 2 * MINUTE,
    });
    expect(message!.steps![0].status).toBe("done");
    expect(message!.steps![1]).toMatchObject({
      status: "error",
      error: "Interrupted",
      endedAt: START + 2 * MINUTE,
    });
  });

  test("leaves a run that recorded progress recently", async () => {
    const t = setup();
    const messageId = await seedMessage(t, {
      status: "processing",
      steps: [
        { id: "a", kind: "tool", tool: "readFiles", status: "running", startedAt: START + 8 * MINUTE },
      ],
    });

    vi.setSystemTime(START + LOST_RUN_MS + MINUTE);
    const result = await t.mutation(internal.maintenance.failLostMessageRuns, {});

    expect(result).toEqual({ scanned: 1, failed: 0 });
    const message = await t.run((ctx) => ctx.db.get("messages", messageId));
    expect(message!.status).toBe("processing");
  });

  test("ignores finished and cancelled messages", async () => {
    const t = setup();
    await seedMessage(t, { status: "completed", content: "Done" });
    await seedMessage(t, { status: "cancelled" });

    vi.setSystemTime(START + 2 * LOST_RUN_MS);
    const result = await t.mutation(internal.maintenance.failLostMessageRuns, {});

    expect(result).toEqual({ scanned: 0, failed: 0 });
  });
});
