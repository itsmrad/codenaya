// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_PUSH_RUNS } from "./githubSync";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";

function setup() {
  const t = convexTest(schema, modules);
  return { t, alice: t.withIdentity({ subject: ALICE }), bob: t.withIdentity({ subject: "user_bob" }) };
}

type T = ReturnType<typeof setup>["t"];

async function seedProject(t: T) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: Date.now() });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: Date.now() });
    await ctx.db.insert("files", { projectId, name: "index.html", type: "file", content: "<h1>v1</h1>", updatedAt: Date.now() });
    return { projectId, conversationId };
  });
}

/** An agent run one second after the previous one, with its pre-run checkpoint. */
async function addRun(
  t: T,
  ids: { projectId: Id<"projects">; conversationId: Id<"conversations"> },
  opts: { prompt: string; status?: "completed" | "cancelled" | "processing"; plan?: boolean },
) {
  vi.advanceTimersByTime(1000);
  const messageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      ...ids,
      role: "assistant",
      content: `Did: ${opts.prompt}`,
      status: opts.status ?? "completed",
      ...(opts.plan ? { mode: "plan" as const } : {}),
    }),
  );
  await t.mutation(api.system.createProjectCheckpoint, {
    internalKey: INTERNAL_KEY,
    projectId: ids.projectId,
    messageId,
    label: opts.prompt,
  });
  return messageId;
}

const link = (t: T, projectId: Id<"projects">, lastSyncedAt: number) =>
  t.mutation(api.system.setGithubSync, {
    internalKey: INTERNAL_KEY,
    projectId,
    githubSync: { repo: "octocat/app", branch: "main", lastSyncedSha: "s0", lastSyncedAt },
  });

describe("GitHub sync state (#343)", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("counts only finished, file-writing runs since the last sync", async () => {
    const { t, alice } = setup();
    const ids = await seedProject(t);
    expect(await alice.query(api.githubSync.unpushedRuns, { projectId: ids.projectId })).toBeNull();

    await addRun(t, ids, { prompt: "already exported" });
    await link(t, ids.projectId, Date.now());
    const first = await addRun(t, ids, { prompt: "make it blue" });
    await addRun(t, ids, { prompt: "just planning", plan: true });
    await addRun(t, ids, { prompt: "still running", status: "processing" });
    const stopped = await addRun(t, ids, { prompt: "stopped halfway", status: "cancelled" });

    expect(await alice.query(api.githubSync.unpushedRuns, { projectId: ids.projectId })).toEqual({
      count: 2,
      more: false,
    });

    const plan = await t.query(api.system.getGithubPushPlan, {
      internalKey: INTERNAL_KEY,
      projectId: ids.projectId,
    });
    expect(plan?.runs).toMatchObject([
      { messageId: first, prompt: "make it blue", summary: "Did: make it blue", checkpointId: expect.any(String) },
      { messageId: stopped, prompt: "stopped halfway" },
    ]);
  });

  test("says when there are more runs than one push commits one by one", async () => {
    const { t, alice } = setup();
    const ids = await seedProject(t);
    await link(t, ids.projectId, Date.now());
    for (let i = 0; i <= MAX_PUSH_RUNS; i++) {
      await t.run((ctx) =>
        ctx.db.insert("messages", { ...ids, role: "assistant", content: "", status: "completed" }),
      );
    }

    expect(await alice.query(api.githubSync.unpushedRuns, { projectId: ids.projectId })).toEqual({
      count: MAX_PUSH_RUNS,
      more: true,
    });
  });

  test("a diverged push counts from the sync branch, and resetting the export keeps the link", async () => {
    const { t, alice } = setup();
    const ids = await seedProject(t);
    await link(t, ids.projectId, Date.now());
    await addRun(t, ids, { prompt: "on the sync branch" });
    await t.mutation(api.system.setGithubSync, {
      internalKey: INTERNAL_KEY,
      projectId: ids.projectId,
      githubSync: {
        repo: "octocat/app",
        branch: "main",
        lastSyncedSha: "s0",
        lastSyncedAt: 0,
        syncBranchSha: "s1",
        syncBranchAt: Date.now(),
      },
    });
    await t.mutation(api.system.updateExportStatus, { internalKey: INTERNAL_KEY, projectId: ids.projectId });

    expect(await alice.query(api.githubSync.unpushedRuns, { projectId: ids.projectId })).toEqual({
      count: 0,
      more: false,
    });
  });

  test("only the owner sees the count", async () => {
    const { t, bob } = setup();
    const ids = await seedProject(t);
    await link(t, ids.projectId, 0);

    await expect(bob.query(api.githubSync.unpushedRuns, { projectId: ids.projectId })).rejects.toThrow();
  });

  test("reads a checkpoint's files only through its own project", async () => {
    const { t } = setup();
    const ids = await seedProject(t);
    const other = await seedProject(t);
    const messageId = await addRun(t, ids, { prompt: "snapshot" });
    const checkpointId = await t.run(async (ctx) =>
      (await ctx.db.query("checkpoints").withIndex("by_message", (q) => q.eq("messageId", messageId)).first())!._id,
    );

    expect(
      await t.query(api.system.getCheckpointFilesWithUrls, {
        internalKey: INTERNAL_KEY,
        projectId: ids.projectId,
        checkpointId,
      }),
    ).toEqual([{ path: "index.html", type: "file", content: "<h1>v1</h1>", storageUrl: null }]);
    await expect(
      t.query(api.system.getCheckpointFilesWithUrls, {
        internalKey: INTERNAL_KEY,
        projectId: other.projectId,
        checkpointId,
      }),
    ).rejects.toThrow("Checkpoint not found");
  });
});
