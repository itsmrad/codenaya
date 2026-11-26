import { beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), connect: vi.fn(), kill: vi.fn(), deleteSnapshot: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), verifyAndFix: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: e2b,
}));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/conversations/server/sandbox-repair", () => ({ verifyAndFix: mocks.verifyAndFix }));

import { RateLimitError } from "e2b";
import { getFunctionName } from "convex/server";

import type { BuildError, VerifyAndFixOptions } from "./server/sandbox-repair";
import { cleanupSwarmSandboxes, seedSwarmSnapshot, selfCheckStep, selfCheckWorker } from "./swarm-sandbox";
import type { Id } from "../../../convex/_generated/dataModel";

const ids = {
  internalKey: "key",
  projectId: "p1" as Id<"projects">,
  messageId: "m1" as Id<"messages">,
};
const ownedPaths = ["src/pages/"];

const fakeSandbox = () => ({
  sandboxId: "sbx",
  getInfo: vi.fn(async () => ({ envdVersion: "0.5.2" })),
  files: { makeDir: vi.fn(async () => true), write: vi.fn(async () => ({})) },
  commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
  createSnapshot: vi.fn(async () => ({ snapshotId: "snap" })),
  kill: vi.fn(async () => true),
});
const running = (...purposes: (string | undefined)[]) => ({
  nextItems: async () => purposes.map((purpose, i) => ({ sandboxId: `s${i}`, metadata: purpose ? { purpose } : {} })),
});
const mutated = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);

const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const onResponse = vi.fn(async () => {});
const selfCheck = (invokedAt = Date.now(), timeoutMs?: number, signal?: AbortSignal) => selfCheckWorker({
  step, ...ids, agentTaskId: "t1" as Id<"agentTasks">, ownedPaths, invokedAt, timeoutMs, model: {} as VerifyAndFixOptions["model"],
  onEvent: async () => {}, onResponse, signal,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SWARM_WORKER_SANDBOXES", "true");
  vi.stubEnv("E2B_API_KEY", "e2b_key");
  vi.stubEnv("SWARM_MAX_WORKER_SANDBOXES", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  step.run.mockImplementation(async (_id, fn) => fn());
  mocks.query.mockResolvedValue([]);
  mocks.mutation.mockImplementation(async (ref) =>
    getFunctionName(ref) === "agentTasks:claimSelfCheck" ? { seedSnapshotId: "snap" } : null);
  e2b.list.mockReturnValue(running());
  e2b.kill.mockResolvedValue(true);
  e2b.deleteSnapshot.mockResolvedValue(undefined);
  mocks.verifyAndFix.mockResolvedValue({ ok: false, status: "scoped-ok", errors: [], filesChanged: [], attempts: 0 });
});

describe("swarm sandboxes", () => {
  it("makes no E2B call while the switch is off, nor without an E2B key", async () => {
    for (const [flag, key] of [["", "e2b_key"], ["true", ""]]) {
      vi.stubEnv("SWARM_WORKER_SANDBOXES", flag);
      vi.stubEnv("E2B_API_KEY", key);
      expect(await seedSwarmSnapshot(ids)).toBeNull();
      expect(await selfCheck()).toBeNull();
    }
    for (const fn of Object.values(e2b)) expect(fn).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("installs the foundation once, snapshots it, stores the id and kills the sandbox", async () => {
    const sandbox = fakeSandbox();
    e2b.create.mockResolvedValue(sandbox);
    expect(await seedSwarmSnapshot(ids)).toBe("snap");
    expect(e2b.create).toHaveBeenCalledTimes(1);
    expect(e2b.create.mock.calls[0][1]).toMatchObject({
      metadata: { projectId: "p1", messageId: "m1", purpose: "swarm-foundation" }, timeoutMs: 5 * 60_000,
    });
    expect(sandbox.commands.run).toHaveBeenCalledWith(expect.stringMatching(/^npm install/), expect.anything());
    expect(sandbox.createSnapshot).toHaveBeenCalledTimes(1);
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
    expect(mutated("agentTasks:setSeedSnapshot")).toEqual([{ internalKey: "key", messageId: "m1", snapshotId: "snap" }]);
  });

  it("writes the project's files, or creates the directory for an install when it has none", async () => {
    const empty = fakeSandbox();
    e2b.create.mockResolvedValue(empty);
    await seedSwarmSnapshot(ids);
    expect(empty.commands.run).toHaveBeenCalledWith("mkdir -p /home/user/app");
    expect(empty.files.write).not.toHaveBeenCalled();

    mocks.query.mockResolvedValue([{ _id: "f1", type: "file", name: "package.json", content: "{}" }]);
    const full = fakeSandbox();
    e2b.create.mockResolvedValue(full);
    await seedSwarmSnapshot(ids);
    expect(full.files.write).toHaveBeenCalledWith([{ path: "/home/user/app/package.json", data: "{}" }]);
    expect(full.commands.run).not.toHaveBeenCalledWith("mkdir -p /home/user/app");
  });

  it("skips the snapshot on an envd too old for snapshots, still killing the sandbox", async () => {
    const sandbox = fakeSandbox();
    sandbox.getInfo.mockResolvedValue({ envdVersion: "0.4.9" });
    e2b.create.mockResolvedValue(sandbox);
    expect(await seedSwarmSnapshot(ids)).toBeNull();
    expect(sandbox.createSnapshot).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("deletes the snapshot and kills the foundation when storing its id fails (cleanup fails: %s)", async (cleanupFails) => {
    const sandbox = fakeSandbox();
    e2b.create.mockResolvedValue(sandbox);
    mocks.mutation.mockRejectedValue(new Error("private storage error"));
    if (cleanupFails) e2b.deleteSnapshot.mockRejectedValue(new Error("cleanup error"));
    expect(await seedSwarmSnapshot(ids)).toBeNull();
    expect(e2b.deleteSnapshot).toHaveBeenCalledWith("snap", { apiKey: "e2b_key" });
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("checks a worker in a sandbox from the snapshot, scoped to its owned files, then kills it", async () => {
    e2b.create.mockResolvedValue(fakeSandbox());
    expect(await selfCheck()).toEqual({ selfCheck: "scoped-ok", filesChanged: [] });
    expect(e2b.create).toHaveBeenCalledWith("snap", expect.objectContaining({
      metadata: { projectId: "p1", messageId: "m1", purpose: "swarm-worker" }, timeoutMs: 8.5 * 60_000,
    }));
    const opts = mocks.verifyAndFix.mock.calls[0][0] as VerifyAndFixOptions;
    // Its sandbox is started from project files only, so there is no value to redact.
    expect(opts).toMatchObject({ maxAttempts: 2, agentTaskId: "t1", runId: "m1", projectId: "p1", onResponse, secrets: [] });
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(typeof opts.sandbox).toBe("function");
    e2b.connect.mockResolvedValue(fakeSandbox());
    if (typeof opts.sandbox === "function") expect((await opts.sandbox()).id).toBe("sbx");
    expect(e2b.connect).toHaveBeenCalledWith("sbx", { apiKey: "e2b_key" });
    expect(opts.allowedPaths?.("src/pages/home.tsx")).toBe(true);
    expect(opts.allowedPaths?.("src/App.tsx")).toBe(false);
    expect(opts.allowedPaths?.("src/nav/menu.tsx")).toBe(false);
    const errors: BuildError[] = [
      { file: "src/pages/home.tsx", line: 1, message: "x", kind: "type" },
      { file: "src/nav/menu.tsx", line: 1, message: "y", kind: "type" },
      { message: "./Card (referenced by src/pages/home.tsx)", kind: "static" },
      { message: "lodash (imported by src/nav/menu.tsx)", kind: "static" },
      { message: "Build failed", kind: "build" },
    ];
    expect(opts.filterErrors?.(errors)).toEqual([errors[0], errors[2]]);
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(["self-check-start", "self-check-stop"]);
    expect(e2b.kill).toHaveBeenCalledWith("sbx", { apiKey: "e2b_key" });
  });

  it("asks for a slot under the per-swarm cap (at most 2) and skips when none is left", async () => {
    mocks.mutation.mockResolvedValue({ skipped: "swarm sandbox cap reached" });
    expect(await selfCheck()).toEqual({ selfCheck: "skipped (swarm sandbox cap reached)", filesChanged: [] });
    vi.stubEnv("SWARM_MAX_WORKER_SANDBOXES", "1");
    await selfCheck();
    vi.stubEnv("SWARM_MAX_WORKER_SANDBOXES", "99");
    await selfCheck();
    expect(mutated("agentTasks:claimSelfCheck").map((args) => args.max)).toEqual([2, 1, 2]);
    expect(e2b.create).not.toHaveBeenCalled();
    expect(mocks.verifyAndFix).not.toHaveBeenCalled();
  });

  it("skips while the swarm budget is used or previews need the room", async () => {
    for (const list of [
      running("swarm-worker", "swarm-worker", "swarm-foundation", "swarm-worker"),
      running(undefined, undefined, undefined, undefined, undefined, undefined, "swarm-worker"),
    ]) {
      e2b.list.mockReturnValue(list);
      expect((await selfCheck())?.selfCheck).toMatch(/^skipped \(/);
      expect(await seedSwarmSnapshot(ids)).toBeNull();
    }
    expect(e2b.create).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("reserves every 150 s verify plus slack, checking without repairs when only one verify fits", async () => {
    const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
    expect(await selfCheck(minutesAgo(8.5))).toEqual({ selfCheck: "skipped (time budget)", filesChanged: [] });
    expect(await selfCheck(minutesAgo(6))).toEqual({ selfCheck: "skipped (time budget)", filesChanged: [] });
    expect(await selfCheck(minutesAgo(7), 10 * 60_000)).toEqual({ selfCheck: "skipped (time budget)", filesChanged: [] });
    for (const fn of Object.values(e2b)) expect(fn).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
    e2b.create.mockResolvedValue(fakeSandbox());
    // A worker with its full 9-min budget (#649) gets both repairs; every check ends a minute before the invoke timeout.
    const now = Date.now();
    await selfCheck(now);
    expect(mocks.verifyAndFix.mock.calls[0][0]).toMatchObject({ maxAttempts: 2, deadline: now + 8 * 60_000 });
    expect(e2b.create.mock.calls[0][1].timeoutMs).toBe(8.5 * 60_000);
    await selfCheck(minutesAgo(2.5));
    expect(mocks.verifyAndFix.mock.calls[1][0]).toMatchObject({ maxAttempts: 1 });
    // A typical 3-6 min worker still gets a check, without repairs.
    await selfCheck(minutesAgo(4));
    expect(mocks.verifyAndFix.mock.calls[2][0]).toMatchObject({ maxAttempts: 0 });
    expect(e2b.create.mock.calls[2][1].timeoutMs).toBe(210_000);
    await selfCheck(minutesAgo(18.5), 25 * 60_000);
    expect(mocks.verifyAndFix.mock.calls[3][0]).toMatchObject({ maxAttempts: 1 });
  });

  it("skips a worker already at its cost cap before claiming a slot or listing sandboxes", async () => {
    const spent = new AbortController();
    spent.abort();
    expect(await selfCheck(Date.now(), undefined, spent.signal)).toEqual({ selfCheck: "skipped (cost budget)", filesChanged: [] });
    for (const fn of Object.values(e2b)) expect(fn).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("stops repairing once a full verify no longer fits before the invoke timeout", async () => {
    vi.useFakeTimers();
    try {
      e2b.create.mockResolvedValue(fakeSandbox());
      let signal: AbortSignal | undefined;
      mocks.verifyAndFix.mockImplementation(async (opts: VerifyAndFixOptions) => {
        signal = opts.signal;
        // 9 min timeout, invoked now: the deadline is 6.5 min away.
        await vi.advanceTimersByTimeAsync(6.5 * 60_000 - 1);
        await opts.step!("verify:1", async () => {});
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await opts.step!("verify:2", async () => {});
        expect(signal?.aborted).toBe(true);
        return { ok: false, status: "unverified", errors: [], filesChanged: [], attempts: 1, reason: "Cancelled" };
      });
      expect(await selfCheck()).toEqual({ selfCheck: "skipped (time budget)", filesChanged: [] });
      expect(console.error).not.toHaveBeenCalled();
      // The cost signal still reaches verifyAndFix through the combined signal.
      const spent = new AbortController();
      mocks.verifyAndFix.mockImplementation(async (opts: VerifyAndFixOptions) => {
        spent.abort();
        expect(opts.signal?.aborted).toBe(true);
        return { ok: false, status: "unverified", errors: [], filesChanged: [], attempts: 1, reason: "Cancelled" };
      });
      expect(await selfCheck(Date.now(), undefined, spent.signal)).toEqual({ selfCheck: "skipped (cost budget)", filesChanged: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays earlier repairs after the deadline without losing their changed files", async () => {
    vi.useFakeTimers();
    try {
      const invokedAt = Date.now() - 9 * 60_000;
      const filesChanged = ["src/pages/home.tsx"];
      const memo = new Map<string, unknown>([
        ["self-check-start", { sandboxId: "sbx", maxAttempts: 1 }],
        ["verify:1-late", false],
        ["verify:1", { status: "failed" }],
        ["sync:1-late", false],
        ["sync:1", filesChanged],
      ]);
      step.run.mockImplementation(async (id, fn) => {
        // Inngest replays memoized steps across timer ticks.
        await vi.advanceTimersByTimeAsync(1);
        if (!memo.has(id)) memo.set(id, await fn());
        return memo.get(id);
      });
      mocks.verifyAndFix.mockImplementation(async (opts: VerifyAndFixOptions) => {
        await vi.advanceTimersByTimeAsync(1);
        if (opts.signal?.aborted) {
          return { status: "unverified", errors: [], filesChanged: [], reason: "Cancelled" };
        }
        const unexpected = async () => { throw new Error("Memoized work must not run again"); };
        await opts.step!("verify:1", unexpected);
        const changed = await opts.step!("sync:1", unexpected);
        expect(opts.signal?.aborted).toBe(false);
        await opts.step!("verify:2", async () => {
          expect(opts.signal?.aborted).toBe(true);
        });
        return { status: "unverified", errors: [], filesChanged: changed, reason: "Cancelled" };
      });

      expect(await selfCheck(invokedAt)).toEqual({ selfCheck: "skipped (time budget)", filesChanged });
      expect(memo.get("verify:2-late")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(e2b.create).not.toHaveBeenCalled();
      expect(e2b.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips on an E2B rate limit", async () => {
    e2b.create.mockRejectedValue(new RateLimitError("Rate limit exceeded"));
    expect(await selfCheck()).toEqual({ selfCheck: "skipped (E2B rate limit)", filesChanged: [] });
    expect(mocks.verifyAndFix).not.toHaveBeenCalled();
  });

  it.each(["create", "claim"])("keeps private %s errors out of the client result and logs them only server-side", async (failure) => {
    const error = new Error("private upstream details");
    if (failure === "create") e2b.create.mockRejectedValue(error);
    else mocks.mutation.mockRejectedValue(error);
    expect(await selfCheck()).toEqual({ selfCheck: "skipped (sandbox unavailable)", filesChanged: [] });
    expect(console.error).toHaveBeenCalledWith("[swarm-sandbox] worker start failed", "p1", error);
  });

  it("never reports verified", async () => {
    const results = [
      [{ status: "verified", errors: [] }, "scoped-ok"],
      [{ status: "failed", errors: [{ file: "src/pages/a.tsx", message: "x", kind: "type" }, { file: "src/b.tsx", message: "y", kind: "type" }] }, "scoped-failed (1 in owned files)"],
      [{ status: "unverified", errors: [], reason: "private upstream details" }, "skipped (check unavailable)"],
    ] as const;
    for (const [result, expected] of results) {
      e2b.create.mockResolvedValue(fakeSandbox());
      mocks.verifyAndFix.mockResolvedValueOnce({ ok: result.status === "verified", filesChanged: ["src/pages/a.tsx"], attempts: 1, ...result });
      expect(await selfCheck()).toEqual({ selfCheck: expected, filesChanged: ["src/pages/a.tsx"] });
    }
    expect(console.error).toHaveBeenCalledWith("[swarm-sandbox] check incomplete", "p1", "private upstream details");
    expect(selfCheckStep({
      id: "verify:1", phase: "verify", attempt: 1, status: "error", reason: "private upstream details",
    }, 1).error).toBe("Self-check could not complete");
  });

  it("cleanup kills the swarm's leftover sandboxes and deletes the snapshot", async () => {
    e2b.list.mockReturnValue(running("swarm-worker", "swarm-foundation", "check-build"));
    await cleanupSwarmSandboxes({ messageId: "m1", snapshotId: "snap" });
    expect(e2b.list).toHaveBeenCalledWith(expect.objectContaining({ query: { metadata: { messageId: "m1" }, state: ["running"] } }));
    expect(e2b.kill.mock.calls.map(([id]) => id)).toEqual(["s0", "s1"]);
    expect(e2b.deleteSnapshot).toHaveBeenCalledWith("snap", { apiKey: "e2b_key" });
  });
});

it("passes the same inference gate and actual worker model into self-check repair", async () => {
  const sandbox = fakeSandbox();
  e2b.create.mockResolvedValue(sandbox);
  e2b.connect.mockResolvedValue(sandbox);
  const permission = { stopped: false, check: vi.fn(), wrap: vi.fn() } as unknown as NonNullable<VerifyAndFixOptions["permission"]>;
  await selfCheckWorker({
    step, ...ids, agentTaskId: "t1" as Id<"agentTasks">, ownedPaths, invokedAt: Date.now(),
    model: {} as VerifyAndFixOptions["model"], permission, modelId: "worker-model",
    onEvent: async () => {}, onResponse,
  });
  expect(mocks.verifyAndFix).toHaveBeenCalledWith(expect.objectContaining({ permission, modelId: "worker-model", purpose: "coding" }));
});
