/**
 * Build repair on any provider, with fake ones: the repair sandbox is created
 * through the registry's failover, reached again on the provider it landed on,
 * and found to stop by its run on every configured provider.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentStep } from "@/features/conversations/agent-steps";
import type { ProviderCooldown } from "@/features/sandbox-preview/server/provider/failover";
import type { ProviderId, Sandbox, SandboxProvider } from "@/features/sandbox-preview/server/provider/types";

import type { Id } from "../../../../convex/_generated/dataModel";

const state = vi.hoisted(() => ({
  providers: [] as SandboxProvider[],
  cooldown: undefined as unknown as ProviderCooldown,
}));

// Not registered on main yet (#911): lets its prefixed ids parse.
vi.mock("@/features/sandbox-preview/server/provider/types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sandbox-preview/server/provider/types")>()),
  PROVIDER_IDS: ["e2b", "blaxel"],
}));

// The pool over fake providers: E2B primary, Blaxel its fallback, the real failover and cooldown.
vi.mock("@/features/sandbox-preview/server/provider/registry", async (importOriginal) => {
  const { createWithFailover } = await import("@/features/sandbox-preview/server/provider/failover");
  return {
    ...(await importOriginal<typeof import("@/features/sandbox-preview/server/provider/registry")>()),
    getSandboxPool: () => state.providers.length ? {
      providers: state.providers,
      health: { primary: "e2b", cooldown: state.cooldown },
      create: (opts: Parameters<SandboxProvider["create"]>[0]) =>
        createWithFailover(opts, { providers: state.providers, cooldown: state.cooldown }),
    } : null,
  };
});

vi.mock("@/lib/convex-client", () => ({
  convex: {
    query: vi.fn(async () => [
      { _id: "v1", name: "package.json", type: "file", content: "{}" },
      { _id: "v2", name: "vite.config.ts", type: "file", content: "export default {};\n" },
    ]),
    mutation: vi.fn(),
  },
}));

const verifyAndFix = vi.hoisted(() => vi.fn());
vi.mock("@/features/conversations/server/sandbox-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/sandbox-repair")>()),
  verifyAndFix,
}));

import { createProviderCooldown } from "@/features/sandbox-preview/server/provider/failover";
import { SandboxRateLimitError } from "@/features/sandbox-preview/server/provider/types";
import type { VerifyAndFixOptions } from "../server/sandbox-repair";
import { killRepairSandboxes, repairBuild } from "./build-repair";
import { drive } from "./process-message.driver";
import { stopRepairSandboxes } from "./stop-repair-sandboxes";

const BLAXEL = "blaxel" as string as ProviderId;

const fakeSandbox = (provider: ProviderId, id: string) => ({
  provider,
  id,
  run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  writeFiles: vi.fn(async () => {}),
  kill: vi.fn(async () => {}),
}) as unknown as Sandbox;

const fakeProvider = (id: ProviderId) => ({
  id,
  maxSessionMs: 60 * 60_000,
  create: vi.fn(async () => fakeSandbox(id, `${id}_new`)),
  connect: vi.fn(async (nativeId: string) => fakeSandbox(id, nativeId)),
  list: vi.fn(async () => [] as Awaited<ReturnType<SandboxProvider["list"]>>),
  kill: vi.fn(async () => true),
});

const listed = (id: string) => ({ id, metadata: {}, endAt: new Date() });
const QUERY = (runId: string) => expect.objectContaining({ metadata: { purpose: "build-repair", runId } });

let e2b: ReturnType<typeof fakeProvider>;
let blaxel: ReturnType<typeof fakeProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  e2b = fakeProvider("e2b");
  blaxel = fakeProvider(BLAXEL);
  state.providers = [e2b, blaxel] as unknown as SandboxProvider[];
  state.cooldown = createProviderCooldown();
  verifyAndFix.mockImplementation(async ({ sandbox }: VerifyAndFixOptions) => {
    await (sandbox as () => Promise<Sandbox>)();
    return { ok: true, status: "verified", errors: [], filesChanged: [], attempts: 0 };
  });
});

const repair = () =>
  repairBuild({
    projectId: "p1" as Id<"projects">,
    internalKey: "ik",
    runId: "run_1",
    messageId: "m1" as Id<"messages">,
    // verifyAndFix is mocked, so the model is never called.
    model: {} as VerifyAndFixOptions["model"],
    step: (_id, fn) => fn(),
    recordSteps: async (_build: () => AgentStep[]) => {},
  });

describe("build repair on any provider", () => {
  it("fails over to the second provider on create, and later reaches the sandbox there", async () => {
    e2b.create.mockRejectedValue(new SandboxRateLimitError("quota"));
    blaxel.list.mockResolvedValue([listed("blaxel_new")]);

    await expect(repair()).resolves.toMatchObject({ ok: true });

    // No E2B template name goes to another provider: each adapter picks its own image.
    expect(blaxel.create).toHaveBeenCalledWith({
      timeoutMs: 10 * 60_000,
      metadata: { projectId: "p1", runId: "run_1", purpose: "build-repair" },
    });
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(blaxel.connect).toHaveBeenCalledExactlyOnceWith("blaxel_new", { timeoutMs: 10 * 60_000 });
    const sandbox = await blaxel.connect.mock.results[0].value;
    expect(sandbox.run).toHaveBeenCalledWith(expect.stringContaining("npm install"), expect.anything());
    expect(blaxel.kill).toHaveBeenCalledWith("blaxel_new", expect.anything());
  });

  it("kills a run's repair sandboxes on every configured provider, each through its own", async () => {
    e2b.list.mockResolvedValue([listed("e2b_a")]);
    blaxel.list.mockResolvedValue([listed("blaxel_b")]);

    await killRepairSandboxes("run_7");

    expect(e2b.list).toHaveBeenCalledWith(QUERY("run_7"));
    expect(blaxel.list).toHaveBeenCalledWith(QUERY("run_7"));
    expect(e2b.kill.mock.calls).toEqual([["e2b_a"]]);
    expect(blaxel.kill.mock.calls).toEqual([["blaxel_b", { requestTimeoutMs: 5_000 }]]);
  });

  it("still fails closed when the primary's list fails", async () => {
    e2b.list.mockRejectedValue(new Error("E2B down"));

    await expect(killRepairSandboxes("run_7")).rejects.toThrow("E2B down");
  });

  it("bounds the direct kill on a fallback-created sandbox when the primary's list fails, and cools it", async () => {
    vi.useFakeTimers();
    try {
      e2b.create.mockRejectedValue(new SandboxRateLimitError("quota"));
      e2b.list.mockRejectedValue(new Error("E2B down"));
      blaxel.kill.mockImplementation(() => new Promise<boolean>(() => {}));

      let settled = false;
      const done = repair().then((result) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(done).resolves.toMatchObject({ ok: true });
      expect(blaxel.kill).toHaveBeenCalledWith("blaxel_new", { requestTimeoutMs: 5_000 });
      expect(state.cooldown.isCoolingDown(BLAXEL)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a cancelled run's sandboxes, skipping a failing fallback and cooling it", async () => {
    e2b.list.mockResolvedValue([listed("e2b_a")]);
    blaxel.list.mockRejectedValue(new Error("Blaxel down"));

    const outcome = await drive({}, [], "", { function_id: "codenaya-process-message", run_id: "run_7" }, {
      fn: stopRepairSandboxes,
      eventName: "inngest/function.cancelled",
    });

    expect(outcome.finalType).toBe("function-resolved");
    expect(e2b.kill.mock.calls).toEqual([["e2b_a"]]);
    expect(blaxel.kill).not.toHaveBeenCalled();
    expect(state.cooldown.isCoolingDown(BLAXEL)).toBe(true);
  });

  it("does nothing without a configured provider", async () => {
    state.providers = [];

    await expect(repair()).resolves.toBeNull();
    await killRepairSandboxes("run_7");
    expect(verifyAndFix).not.toHaveBeenCalled();
  });
});
