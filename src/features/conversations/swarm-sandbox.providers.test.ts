/**
 * Swarm worker sandboxes on any provider, with fake ones: the foundation runs on
 * the primary, each worker on the provider that made the snapshot, and the
 * cleanup kills on every provider but deletes the snapshot only where it lives.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderCooldown } from "@/features/sandbox-preview/server/provider/failover";
import type { ProviderId, Sandbox, SandboxProvider } from "@/features/sandbox-preview/server/provider/types";

const state = vi.hoisted(() => ({
  providers: [] as SandboxProvider[],
  primary: "e2b" as string,
  cooldown: undefined as unknown as ProviderCooldown,
}));
const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), verifyAndFix: vi.fn() }));

// Not registered on main yet (#911): lets its prefixed ids parse.
vi.mock("@/features/sandbox-preview/server/provider/types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sandbox-preview/server/provider/types")>()),
  PROVIDER_IDS: ["e2b", "blaxel"],
}));
vi.mock("@/features/sandbox-preview/server/provider/registry", () => ({
  getSandboxPool: () => state.providers.length
    ? { providers: state.providers, health: { primary: state.primary, cooldown: state.cooldown }, create: vi.fn() }
    : null,
}));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/conversations/server/sandbox-repair", () => ({ verifyAndFix: mocks.verifyAndFix }));

import { getFunctionName } from "convex/server";

import { createProviderCooldown } from "@/features/sandbox-preview/server/provider/failover";
import { SandboxRateLimitError } from "@/features/sandbox-preview/server/provider/types";
import type { VerifyAndFixOptions } from "./server/sandbox-repair";
import { cleanupSwarmSandboxes, seedSwarmSnapshot, selfCheckWorker } from "./swarm-sandbox";
import type { Id } from "../../../convex/_generated/dataModel";

const BLAXEL = "blaxel" as string as ProviderId;
const ids = { internalKey: "key", projectId: "p1" as Id<"projects">, messageId: "m1" as Id<"messages"> };

const fakeSandbox = (provider: ProviderId, id: string) => ({
  provider,
  id,
  run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  writeFiles: vi.fn(async () => {}),
  info: vi.fn(async () => ({ metadata: {}, endAt: new Date() })),
  kill: vi.fn(async () => {}),
}) as unknown as Sandbox;

const fakeProvider = (id: ProviderId) => ({
  id,
  maxSessionMs: 60 * 60_000,
  create: vi.fn(async () => fakeSandbox(id, `${id}_foundation`)),
  connect: vi.fn(async (nativeId: string) => fakeSandbox(id, nativeId)),
  list: vi.fn(async () => [] as Awaited<ReturnType<SandboxProvider["list"]>>),
  kill: vi.fn(async () => true),
  snapshot: vi.fn(async () => `${id}_snap`),
  createFromSnapshot: vi.fn(async () => fakeSandbox(id, `${id}_worker`)),
  deleteSnapshot: vi.fn(async () => true),
});

const listed = (id: string, purpose: string) => ({ id, metadata: { purpose }, endAt: new Date() });
const mutated = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);
const claimReturns = (seedSnapshotId: string) => mocks.mutation.mockImplementation(async (ref) =>
  getFunctionName(ref) === "agentTasks:claimSelfCheck" ? { seedSnapshotId } : null);

const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const selfCheck = () => selfCheckWorker({
  step, ...ids, agentTaskId: "t1" as Id<"agentTasks">, ownedPaths: ["src/"], invokedAt: Date.now(),
  model: {} as VerifyAndFixOptions["model"], onEvent: async () => {}, onResponse: async () => {},
});

let e2b: ReturnType<typeof fakeProvider>;
let blaxel: ReturnType<typeof fakeProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SWARM_WORKER_SANDBOXES", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  e2b = fakeProvider("e2b");
  blaxel = fakeProvider(BLAXEL);
  state.providers = [e2b, blaxel] as unknown as SandboxProvider[];
  state.primary = "e2b";
  state.cooldown = createProviderCooldown();
  mocks.query.mockResolvedValue([]);
  mocks.mutation.mockResolvedValue(null);
  mocks.verifyAndFix.mockImplementation(async ({ sandbox }: VerifyAndFixOptions) => {
    await (sandbox as () => Promise<Sandbox>)();
    return { ok: false, status: "scoped-ok", errors: [], filesChanged: [], attempts: 0 };
  });
});

describe("swarm sandboxes on any provider", () => {
  it("seeds on a Blaxel primary and stores its snapshot id with the provider", async () => {
    state.primary = BLAXEL;

    expect(await seedSwarmSnapshot(ids)).toBe("blaxel:blaxel_snap");

    expect(blaxel.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { projectId: "p1", messageId: "m1", purpose: "swarm-foundation" } }));
    expect(blaxel.snapshot).toHaveBeenCalledWith(expect.objectContaining({ provider: BLAXEL, id: "blaxel_foundation" }), expect.anything());
    expect(mutated("agentTasks:setSeedSnapshot")).toEqual([{ internalKey: "key", messageId: "m1", snapshotId: "blaxel:blaxel_snap" }]);
    expect(e2b.create).not.toHaveBeenCalled();
    expect(e2b.snapshot).not.toHaveBeenCalled();
  });

  it("starts, reaches and stops a worker on the provider that made the snapshot", async () => {
    claimReturns("blaxel:blaxel_snap");

    expect(await selfCheck()).toEqual({ selfCheck: "scoped-ok", filesChanged: [] });

    expect(blaxel.createFromSnapshot).toHaveBeenCalledWith("blaxel_snap", expect.objectContaining({
      metadata: { projectId: "p1", messageId: "m1", purpose: "swarm-worker" },
    }));
    expect(blaxel.connect).toHaveBeenCalledWith("blaxel_worker");
    expect(blaxel.kill).toHaveBeenCalledWith("blaxel_worker");
    expect(e2b.createFromSnapshot).not.toHaveBeenCalled();
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(e2b.kill).not.toHaveBeenCalled();
  });

  it("never sends a snapshot id to another provider", async () => {
    claimReturns("e2b_snap");
    await selfCheck();
    expect(e2b.createFromSnapshot).toHaveBeenCalledWith("e2b_snap", expect.anything());
    expect(blaxel.createFromSnapshot).not.toHaveBeenCalled();

    // Its provider is no longer configured: skipped, and no other provider gets the id.
    state.providers = [e2b] as unknown as SandboxProvider[];
    e2b.createFromSnapshot.mockClear();
    claimReturns("blaxel:blaxel_snap");
    expect(await selfCheck()).toEqual({ selfCheck: "skipped (sandbox unavailable)", filesChanged: [] });
    expect(e2b.createFromSnapshot).not.toHaveBeenCalled();
  });

  it("checks the snapshot provider's budget and names it on a rate limit", async () => {
    claimReturns("blaxel:blaxel_snap");
    blaxel.createFromSnapshot.mockRejectedValue(new SandboxRateLimitError("quota"));

    expect(await selfCheck()).toEqual({ selfCheck: "skipped (BLAXEL rate limit)", filesChanged: [] });
    expect(e2b.list).toHaveBeenCalledWith({ limit: 100 });
    expect(blaxel.list).toHaveBeenCalledWith({ limit: 100 });
  });

  it("cleans up on every provider and deletes the snapshot only where it lives", async () => {
    e2b.list.mockResolvedValue([listed("e2b_a", "swarm-worker"), listed("e2b_p", "preview")]);
    blaxel.list.mockResolvedValue([listed("blaxel_b", "swarm-worker")]);

    await cleanupSwarmSandboxes({ messageId: "m1", snapshotId: "blaxel:blaxel_snap" });

    expect(e2b.list).toHaveBeenCalledWith({ metadata: { messageId: "m1" }, limit: 100 });
    expect(e2b.kill.mock.calls).toEqual([["e2b_a"]]);
    expect(blaxel.kill.mock.calls).toEqual([["blaxel_b", { requestTimeoutMs: 5_000 }]]);
    expect(blaxel.deleteSnapshot).toHaveBeenCalledExactlyOnceWith("blaxel_snap");
    expect(e2b.deleteSnapshot).not.toHaveBeenCalled();
  });

  it("still deletes the snapshot when a fallback's list fails, skipping and cooling it", async () => {
    blaxel.list.mockRejectedValue(new Error("Blaxel down"));

    await cleanupSwarmSandboxes({ messageId: "m1", snapshotId: "e2b_snap" });

    expect(state.cooldown.isCoolingDown(BLAXEL)).toBe(true);
    expect(e2b.deleteSnapshot).toHaveBeenCalledExactlyOnceWith("e2b_snap");
    expect(blaxel.deleteSnapshot).not.toHaveBeenCalled();
  });
});
