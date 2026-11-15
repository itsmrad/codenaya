// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { deleteProjectBatch, CASCADE_BATCH_SIZE } from "./projectCascade";
import schema from "./schema";
import { MAX_SWARM_AGENTS } from "./swarm";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

const seedMessage = (t: TestConvex, ownerId = ALICE) => t.run(async (ctx) => {
  const projectId = await ctx.db.insert("projects", { name: "App", ownerId, updatedAt: 1 });
  const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 1 });
  const messageId = await ctx.db.insert("messages", {
    conversationId, projectId, role: "assistant", content: "", mode: "swarm",
  });
  return { projectId, messageId };
});

const task = (taskId = "build-ui") => ({
  taskId, role: "worker" as "worker" | "sub-orchestrator", title: "Build UI", brief: "Build the page",
  ownedPaths: ["src/page.tsx"], modelId: "haiku-test", model: "Haiku test",
});
const create = (t: TestConvex, parent: Awaited<ReturnType<typeof seedMessage>>, tasks = [task()]) =>
  t.mutation(api.agentTasks.createTasks, { internalKey: INTERNAL_KEY, ...parent, tasks });
const get = (t: TestConvex, messageId: Awaited<ReturnType<typeof seedMessage>>["messageId"]) =>
  t.withIdentity({ subject: ALICE }).query(api.agentTasks.listForMessage, { messageId });

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("agentTasks", () => {
  test("replays creation by message and task id without overwriting live state", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const tasks = [task("build-ui"), task("add-tests")];
    const ids = await create(t, parent, tasks);
    await t.mutation(api.agentTasks.startTask, { internalKey: INTERNAL_KEY, agentTaskId: ids[0], parentMessageId: parent.messageId, projectId: parent.projectId });
    expect(await create(t, parent, tasks.map((entry) => ({ ...entry, brief: "Changed" })))).toEqual(ids);
    expect(await get(t, parent.messageId)).toMatchObject([
      { _id: ids[0], status: "running", brief: "Build the page", steps: [] },
      { _id: ids[1], status: "queued" },
    ]);
    const other = await seedMessage(t);
    expect(await create(t, other)).not.toEqual([ids[0]]);
    // A duplicate within one request also returns the original row.
    expect(await create(t, parent, [task(), task()])).toEqual([ids[0], ids[0]]);
  });

  test("checks the message's project and caps tasks across multiple calls", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const other = await seedMessage(t, BOB);
    await expect(create(t, { ...parent, projectId: other.projectId })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    const tasks = Array.from({ length: 4 }, (_, i) => task(`task-${i}`));
    const ids = await create(t, parent, tasks.slice(0, 2));
    expect(await create(t, parent, tasks)).toMatchObject([ids[0], ids[1], expect.any(String), expect.any(String)]);
    // A sub-orchestrator's workers count toward the same per-message cap: the 9th agent is refused.
    const children = Array.from({ length: MAX_SWARM_AGENTS - 4 }, (_, i) => ({ ...task(`task-0/c${i}`), parentTaskId: "task-0" }));
    await create(t, parent, children);
    await expect(create(t, parent, [task("extra")])).rejects.toMatchObject({ data: { code: "LIMIT_EXCEEDED" } });
    const rows = await get(t, parent.messageId);
    expect(rows).toHaveLength(MAX_SWARM_AGENTS);
    expect(rows.at(-1)).toMatchObject({ taskId: "task-0/c3", parentTaskId: "task-0" });
  });

  test("only a swarm-mode assistant reply can have tasks", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    for (const patch of [{ mode: undefined }, { mode: "plan" as const }, { role: "user" as const }]) {
      await t.run((ctx) => ctx.db.patch("messages", parent.messageId, { mode: "swarm", role: "assistant", ...patch }));
      await expect(create(t, parent)).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
    }
    expect(await get(t, parent.messageId)).toEqual([]);
  });

  test("a platform run gets sub-orchestrators only when SWARM_PLATFORM_MAX_DEPTH=2; BYOK always", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const sub = { ...task("big"), role: "sub-orchestrator" as const };
    await expect(create(t, parent, [sub])).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
    await expect(t.query(api.swarm.getSwarmSettings, {})).resolves.toEqual({ enabled: true, platformMaxDepth: 1 });
    const [byok] = await t.mutation(api.agentTasks.createTasks, { internalKey: INTERNAL_KEY, ...parent, tasks: [sub], byok: true });
    vi.stubEnv("SWARM_PLATFORM_MAX_DEPTH", "2");
    await expect(t.query(api.swarm.getSwarmSettings, {})).resolves.toEqual({ enabled: true, platformMaxDepth: 2 });
    const [platform] = await create(t, parent, [{ ...sub, taskId: "big-2" }]);
    expect((await get(t, parent.messageId)).map(({ _id, platform: p, ownerId }) => ({ _id, p, ownerId }))).toEqual([
      { _id: byok, p: false, ownerId: ALICE }, { _id: platform, p: true, ownerId: ALICE },
    ]);
  });

  test("one platform swarm per owner fans out at a time; BYOK and finished runs don't count", async () => {
    const t = setup();
    const running = (ctx: Parameters<Parameters<TestConvex["run"]>[0]>[0], messageId: Id<"messages">) =>
      ctx.db.patch("messages", messageId, { status: "processing" });
    const first = await seedMessage(t);
    const second = await seedMessage(t);
    await t.run((ctx) => running(ctx, first.messageId).then(() => running(ctx, second.messageId)));
    const [firstTask] = await create(t, first);
    await expect(create(t, second)).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    // The first swarm's own later calls (a sub-orchestrator's workers) and replays still go through.
    await create(t, first, [task(), task("more")]);
    // BYOK is bounded by its step caps instead; another owner is unaffected.
    await t.mutation(api.agentTasks.createTasks, { internalKey: INTERNAL_KEY, ...second, tasks: [task("byok")], byok: true });
    const bob = await seedMessage(t, BOB);
    await t.run((ctx) => running(ctx, bob.messageId));
    await create(t, bob);
    // Rows left running under a cancelled message don't block the next swarm.
    await t.run((ctx) => ctx.db.patch("messages", first.messageId, { status: "cancelled" }));
    await create(t, second);
    await t.run((ctx) => running(ctx, first.messageId));
    await t.mutation(api.agentTasks.finishTask, { internalKey: INTERNAL_KEY, agentTaskId: firstTask, status: "done" });
    await expect(create(t, first, [task("late")])).rejects.toMatchObject({ data: { code: "CONFLICT" } });
  });

  test("a failed sub-orchestrator fails its unfinished workers with it", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    vi.stubEnv("SWARM_PLATFORM_MAX_DEPTH", "2");
    const [subId] = await create(t, parent, [{ ...task("big"), role: "sub-orchestrator" as const }, task("other")]);
    const child = (id: string) => ({ ...task(`big/${id}`), parentTaskId: "big" });
    const [doneId] = await create(t, parent, [child("a"), child("b"), child("c")]);
    await t.mutation(api.agentTasks.finishTask, { internalKey: INTERNAL_KEY, agentTaskId: doneId, status: "done", summary: "ok" });
    vi.setSystemTime(3000);
    await t.mutation(api.agentTasks.finishTask, { internalKey: INTERNAL_KEY, agentTaskId: subId, status: "error", error: "Failed" });
    expect((await get(t, parent.messageId)).map(({ taskId, status, error, endedAt }) => ({ taskId, status, error, endedAt }))).toEqual([
      { taskId: "big", status: "error", error: "Failed", endedAt: 3000 },
      { taskId: "other", status: "queued", error: undefined, endedAt: undefined },
      { taskId: "big/a", status: "done", error: undefined, endedAt: 1000 },
      { taskId: "big/b", status: "error", error: "Parent sub-orchestrator failed.", endedAt: 3000 },
      { taskId: "big/c", status: "error", error: "Parent sub-orchestrator failed.", endedAt: 3000 },
    ]);
  });

  test("a finished task keeps its steps, and finishing an unstarted one sets startedAt", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const [agentTaskId] = await create(t, parent);
    const step = { id: "late", kind: "thinking" as const, startedAt: 10, status: "done" as const };
    vi.setSystemTime(2000);
    await t.mutation(api.agentTasks.finishTask, { internalKey: INTERNAL_KEY, agentTaskId, status: "error", error: "Failed" });
    await t.mutation(api.agentTasks.upsertTaskSteps, { internalKey: INTERNAL_KEY, agentTaskId, steps: [step] });
    expect((await get(t, parent.messageId))[0]).toMatchObject({ status: "error", steps: [], startedAt: 2000, endedAt: 2000 });
  });

  test("only the project owner can list a message's tasks, in creation order", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const [first] = await create(t, parent, [task("z-first")]);
    vi.setSystemTime(2000);
    const [second] = await create(t, parent, [task("a-second")]);
    expect((await get(t, parent.messageId)).map((row) => row._id)).toEqual([first, second]);
    await expect(t.withIdentity({ subject: BOB }).query(api.agentTasks.listForMessage, { messageId: parent.messageId }))
      .rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(t.query(api.agentTasks.listForMessage, { messageId: parent.messageId }))
      .rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await t.run((ctx) => ctx.db.patch("projects", parent.projectId, { deletingAt: 2000 }));
    await expect(get(t, parent.messageId)).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(create(t, parent)).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await t.run((ctx) => ctx.db.delete("messages", parent.messageId));
    await expect(get(t, parent.messageId)).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("merges steps exactly like messages, retaining omitted fields and the latest 100", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const [agentTaskId] = await create(t, parent);
    const batches = [
      [{ id: "first", kind: "tool" as const, tool: "write", targets: ["src/page.tsx"], startedAt: 10, status: "running" as const }],
      [{ id: "first", kind: "tool" as const, startedAt: 20, status: "done" as const, endedAt: 30 }],
      Array.from({ length: 105 }, (_, i) => ({ id: `step-${i}`, kind: "thinking" as const, startedAt: i + 40, status: "done" as const })),
    ];
    for (const steps of batches) {
      await t.mutation(api.agentTasks.upsertTaskSteps, { internalKey: INTERNAL_KEY, agentTaskId, steps });
      await t.mutation(api.system.upsertMessageSteps, { internalKey: INTERNAL_KEY, messageId: parent.messageId, steps });
      const [row] = await get(t, parent.messageId);
      expect(row.steps).toEqual(await t.run(async (ctx) => (await ctx.db.get("messages", parent.messageId))?.steps));
      if (steps[0].id === "first") {
        expect(row.steps[0]).toMatchObject({ startedAt: 10, targets: ["src/page.tsx"], tool: "write" });
      }
    }
    const [row] = await get(t, parent.messageId);
    expect(row.steps).toHaveLength(100);
    expect(row.steps[0].id).toBe("step-5");
    expect(row.steps.at(-1)?.id).toBe("step-104");
    await t.mutation(api.agentTasks.upsertTaskSteps, { internalKey: INTERNAL_KEY, agentTaskId, steps: row.steps });
    expect((await get(t, parent.messageId))[0].steps).toEqual(row.steps);
    expect((await get(t, parent.messageId))[0].updatedAt).toBe(1000);
  });

  test.each(["done", "error"] as const)("records %s lifecycle once; replays cannot reopen a finished task", async (status) => {
    const t = setup();
    const parent = await seedMessage(t);
    const [agentTaskId] = await create(t, parent);
    const args = { internalKey: INTERNAL_KEY, agentTaskId };
    const startArgs = { ...args, parentMessageId: parent.messageId, projectId: parent.projectId };
    expect(await t.mutation(api.agentTasks.startTask, startArgs)).toEqual({
      ...task(), ...parent, status: "running",
    });
    vi.setSystemTime(2000);
    expect(await t.mutation(api.agentTasks.startTask, startArgs)).toMatchObject({ status: "running", ownedPaths: ["src/page.tsx"] });
    await t.mutation(api.agentTasks.finishTask, { ...args, status, summary: "Finished", ...(status === "error" ? { error: "Failed" } : {}) });
    const [row] = await get(t, parent.messageId);
    expect(row).toMatchObject({ status, summary: "Finished", startedAt: 1000, endedAt: 2000, updatedAt: 2000 });
    if (status === "error") expect(row.error).toBe("Failed");
    vi.setSystemTime(3000);
    expect(await t.mutation(api.agentTasks.startTask, startArgs)).toMatchObject({ status });
    await t.mutation(api.agentTasks.finishTask, { ...args, status, summary: "Replay" });
    expect(await get(t, parent.messageId)).toEqual([row]);
  });

  test("every write requires the internal key and tolerates tasks deleted mid-run", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const [agentTaskId] = await create(t, parent);
    await expect(t.mutation(api.agentTasks.createTasks, { ...parent, tasks: [task()], internalKey: "wrong" }))
      .rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    const args = { internalKey: "wrong", agentTaskId };
    const startArgs = { parentMessageId: parent.messageId, projectId: parent.projectId };
    await expect(t.mutation(api.agentTasks.startTask, { ...args, ...startArgs })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await expect(t.mutation(api.agentTasks.finishTask, { ...args, status: "done" })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await expect(t.mutation(api.agentTasks.upsertTaskSteps, { ...args, steps: [] })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    await t.run((ctx) => ctx.db.delete("agentTasks", agentTaskId));
    const valid = { ...args, internalKey: INTERNAL_KEY };
    await expect(t.mutation(api.agentTasks.startTask, { ...valid, ...startArgs })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect(await t.mutation(api.agentTasks.finishTask, { ...valid, status: "done" })).toBeNull();
    expect(await t.mutation(api.agentTasks.upsertTaskSteps, { ...valid, steps: [] })).toBeNull();
  });

  test("startTask rejects a task from another message or project", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const other = await seedMessage(t);
    const [agentTaskId] = await create(t, parent);
    const args = { internalKey: INTERNAL_KEY, agentTaskId };
    for (const ids of [
      { parentMessageId: other.messageId, projectId: parent.projectId },
      { parentMessageId: parent.messageId, projectId: other.projectId },
    ]) {
      await expect(t.mutation(api.agentTasks.startTask, { ...args, ...ids })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    }
    expect((await get(t, parent.messageId))[0].status).toBe("queued");
  });

  test("cascade deletes task batches before messages, preserving other projects", async () => {
    const t = setup();
    const parent = await seedMessage(t);
    const other = await seedMessage(t);
    const [survivingId] = await create(t, other);
    // Seed more than a batch to prove cleanup remains bounded even for legacy data.
    await t.run(async (ctx) => {
      for (let i = 0; i < CASCADE_BATCH_SIZE + 1; i++) {
        await ctx.db.insert("agentTasks", { ...task(`task-${i}`), ...parent, status: "queued", steps: [], updatedAt: 1 });
      }
    });
    expect(await t.run((ctx) => deleteProjectBatch(ctx, parent.projectId))).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("agentTasks").withIndex("by_project", (q) => q.eq("projectId", parent.projectId)).collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get("messages", parent.messageId))).not.toBeNull();
    await t.run(async (ctx) => { while (!(await deleteProjectBatch(ctx, parent.projectId))); });
    expect(await t.run((ctx) => ctx.db.get("projects", parent.projectId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("agentTasks").collect())).toMatchObject([{ _id: survivingId }]);
  });
});
