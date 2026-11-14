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
import { cleanupSwarmSandboxes, seedSwarmSnapshot, selfCheckWorker } from "./swarm-sandbox";
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

const step = { run: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) };
const selfCheck = (invokedAt = Date.now()) => selfCheckWorker({
  step, ...ids, agentTaskId: "t1" as Id<"agentTasks">, ownedPaths, invokedAt, model: {} as VerifyAndFixOptions["model"],
  onEvent: async () => {},
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

  it("skips the snapshot on an envd too old for snapshots, still killing the sandbox", async () => {
    const sandbox = fakeSandbox();
    sandbox.getInfo.mockResolvedValue({ envdVersion: "0.4.9" });
    e2b.create.mockResolvedValue(sandbox);
    expect(await seedSwarmSnapshot(ids)).toBeNull();
    expect(sandbox.createSnapshot).not.toHaveBeenCalled();
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("checks a worker in a sandbox from the snapshot, scoped to its owned files, then kills it", async () => {
    e2b.create.mockResolvedValue(fakeSandbox());
    expect(await selfCheck()).toEqual({ selfCheck: "scoped-ok", filesChanged: [] });
    expect(e2b.create).toHaveBeenCalledWith("snap", expect.objectContaining({
      metadata: { projectId: "p1", messageId: "m1", purpose: "swarm-worker" }, timeoutMs: 10 * 60_000,
    }));
    const opts = mocks.verifyAndFix.mock.calls[0][0] as VerifyAndFixOptions;
    expect(opts).toMatchObject({ maxAttempts: 2, agentTaskId: "t1", runId: "m1", projectId: "p1" });
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

  it("asks for a slot under the per-swarm cap (2, env-overridable) and skips when none is left", async () => {
    mocks.mutation.mockResolvedValue({ skipped: "swarm sandbox cap reached" });
    expect(await selfCheck()).toEqual({ selfCheck: "skipped (swarm sandbox cap reached)", filesChanged: [] });
    vi.stubEnv("SWARM_MAX_WORKER_SANDBOXES", "1");
    await selfCheck();
    expect(mutated("agentTasks:claimSelfCheck").map((args) => args.max)).toEqual([2, 1]);
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

  it("skips with under 4 min of the worker's timeout left, and fits the repairs to what is left", async () => {
    const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
    expect(await selfCheck(minutesAgo(8.5))).toEqual({ selfCheck: "skipped (time budget)", filesChanged: [] });
    for (const fn of Object.values(e2b)) expect(fn).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
    e2b.create.mockResolvedValue(fakeSandbox());
    await selfCheck(minutesAgo(4.5));
    expect(mocks.verifyAndFix.mock.calls[0][0]).toMatchObject({ maxAttempts: 1 });
  });

  it("skips on an E2B rate limit", async () => {
    e2b.create.mockRejectedValue(new RateLimitError("Rate limit exceeded"));
    expect(await selfCheck()).toEqual({ selfCheck: "skipped (E2B rate limit)", filesChanged: [] });
    expect(mocks.verifyAndFix).not.toHaveBeenCalled();
  });

  it("never reports verified", async () => {
    const results = [
      [{ status: "verified", errors: [] }, "scoped-ok"],
      [{ status: "failed", errors: [{ file: "src/pages/a.tsx", message: "x", kind: "type" }, { file: "src/b.tsx", message: "y", kind: "type" }] }, "scoped-failed (1 in owned files)"],
      [{ status: "unverified", errors: [], reason: "Cancelled" }, "skipped (Cancelled)"],
    ] as const;
    for (const [result, expected] of results) {
      e2b.create.mockResolvedValue(fakeSandbox());
      mocks.verifyAndFix.mockResolvedValueOnce({ ok: result.status === "verified", filesChanged: ["src/pages/a.tsx"], attempts: 1, ...result });
      expect(await selfCheck()).toEqual({ selfCheck: expected, filesChanged: ["src/pages/a.tsx"] });
    }
  });

  it("cleanup kills the swarm's leftover sandboxes and deletes the snapshot", async () => {
    e2b.list.mockReturnValue(running("swarm-worker", "swarm-foundation", "check-build"));
    await cleanupSwarmSandboxes({ messageId: "m1", snapshotId: "snap" });
    expect(e2b.list).toHaveBeenCalledWith(expect.objectContaining({ query: { metadata: { messageId: "m1" }, state: ["running"] } }));
    expect(e2b.kill.mock.calls.map(([id]) => id)).toEqual(["s0", "s1"]);
    expect(e2b.deleteSnapshot).toHaveBeenCalledWith("snap", { apiKey: "e2b_key" });
  });
});
