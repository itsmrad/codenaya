// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const messageId = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId: "user_alice",
      updatedAt: Date.now(),
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: Date.now(),
    });
    return ctx.db.insert("messages", {
      conversationId,
      projectId,
      role: "assistant",
      content: "",
      status: "processing",
    });
  });
  const append = (delta: string, offset: number, internalKey = INTERNAL_KEY) =>
    t.mutation(api.system.appendMessageChunk, { internalKey, messageId, delta, offset });
  const content = () => t.run(async (ctx) => (await ctx.db.get(messageId))?.content);
  return { t, messageId, append, content };
}

describe("appendMessageChunk", () => {
  test("appends streamed chunks in order", async () => {
    const { append, content } = await setup();
    await append("Hel", 0);
    await append("lo", 3);
    expect(await content()).toBe("Hello");
  });

  test("ignores chunks replayed by an Inngest retry", async () => {
    const { append, content } = await setup();
    await append("Hel", 0);
    await append("lo", 3);
    // A replay resends the same text from offset 0.
    await append("Hel", 0);
    await append("lo", 3);
    expect(await content()).toBe("Hello");
  });

  test("appends only new text when a replay splits chunks differently", async () => {
    const { append, content } = await setup();
    await append("Hel", 0);
    // Timed flushes split the replay as "He" + "llo world".
    await append("He", 0);
    await append("llo world", 2);
    expect(await content()).toBe("Hello world");
  });

  test("skips a chunk that would leave a gap after a dropped one", async () => {
    const { append, content } = await setup();
    await append("Hel", 0);
    await append("world", 6);
    expect(await content()).toBe("Hel");
  });

  test("ignores chunks once the run is no longer processing", async () => {
    const { t, messageId, append, content } = await setup();
    await t.run((ctx) => ctx.db.patch(messageId, { status: "cancelled" }));
    await append("late", 0);
    expect(await content()).toBe("");
  });

  test("rejects a wrong internal key", async () => {
    const { append } = await setup();
    await expect(append("x", 0, "wrong-key")).rejects.toThrow();
  });
});
