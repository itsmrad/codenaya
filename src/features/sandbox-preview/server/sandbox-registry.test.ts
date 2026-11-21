import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getProvider: vi.fn(),
  config: vi.fn(),
  realConfig: undefined as unknown as (...args: unknown[]) => unknown,
}));

vi.mock("./provider/registry", () => ({ getProvider: mocks.getProvider }));
vi.mock("./provider/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider/config")>();
  mocks.realConfig = actual.parseProviderConfig as (...args: unknown[]) => unknown;
  return { ...actual, parseProviderConfig: (...args: unknown[]) => mocks.config(...args) };
});

import { type ProviderId, type Sandbox, SandboxNotFoundError, SandboxRateLimitError } from "./provider/types";

import {
  forgetSandbox,
  getOwnedSandbox,
  rememberSandbox,
  requestReinstall,
  waitForReinstall,
} from "./sandbox-registry";

const fakeSandbox = (sandboxId: string, ownerId?: string) =>
  ({
    provider: "e2b",
    id: sandboxId,
    info: vi.fn().mockResolvedValue({ metadata: { userId: ownerId } }),
  }) as unknown as Sandbox;

describe("sandbox registry", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    vi.stubEnv("SANDBOX_PROVIDER_FALLBACKS", "");
    mocks.connect.mockReset();
    mocks.getProvider.mockReset().mockReturnValue({ connect: mocks.connect });
    mocks.config.mockReset().mockImplementation((...args: unknown[]) => mocks.realConfig(...args));
    forgetSandbox("sbx_1");
  });

  it("reuses a remembered sandbox without reconnecting", async () => {
    const sandbox = fakeSandbox("sbx_1");
    rememberSandbox(sandbox, "user_a");

    expect(await getOwnedSandbox("sbx_1", "user_a")).toBe(sandbox);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("refuses a remembered sandbox to another user", async () => {
    rememberSandbox(fakeSandbox("sbx_1"), "user_a");

    expect(await getOwnedSandbox("sbx_1", "user_b")).toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("connects and checks the owner once, then serves from the cache", async () => {
    const sandbox = fakeSandbox("sbx_1", "user_a");
    mocks.connect.mockResolvedValue(sandbox);

    expect(await getOwnedSandbox("sbx_1", "user_a")).toBe(sandbox);
    expect(await getOwnedSandbox("sbx_1", "user_a")).toBe(sandbox);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(sandbox.info).toHaveBeenCalledTimes(1);
  });

  it("does not cache a sandbox the caller does not own", async () => {
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_1", "user_a"));

    expect(await getOwnedSandbox("sbx_1", "user_b")).toBeNull();
    expect(await getOwnedSandbox("sbx_1", "user_b")).toBeNull();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("routes a prefixed id to its provider by the native id, and still checks the owner", async () => {
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_2", "user_a"));

    expect(await getOwnedSandbox("e2b:sbx_2", "user_b")).toBeNull();
    expect(mocks.getProvider).toHaveBeenCalledWith("e2b");
    expect(mocks.connect).toHaveBeenCalledWith("sbx_2");
    forgetSandbox("e2b:sbx_2");
  });

  it.each(["other:sbx_1", "e2b:", "../sbx", "sbx 1"])("refuses a malformed or unknown-provider id %j without connecting", async (id) => {
    expect(await getOwnedSandbox(id, "user_a")).toBeNull();
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(["e2b:sbx_9", "sbx_9"])(
    "refuses %j on an unconfigured provider exactly like an unknown id, without probing it",
    async (id) => {
      vi.stubEnv("E2B_API_KEY", "");

      expect(await getOwnedSandbox(id, "user_a")).toBeNull();
      expect(await getOwnedSandbox("other:sbx_9", "user_a")).toBeNull();
      expect(mocks.getProvider).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
    },
  );

  it("refuses a Blaxel id while Blaxel is not configured, without probing it", async () => {
    vi.stubEnv("BL_API_KEY", "");
    vi.stubEnv("BL_WORKSPACE", "workspace");

    expect(await getOwnedSandbox("blaxel:cn-abc123", "user_a")).toBeNull();
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("routes a Blaxel id to Blaxel once configured, and still checks the owner", async () => {
    vi.stubEnv("BL_API_KEY", "bl_key");
    vi.stubEnv("BL_WORKSPACE", "workspace");
    mocks.connect.mockResolvedValue({ ...fakeSandbox("cn-abc123", "user_a"), provider: "blaxel" });

    expect(await getOwnedSandbox("blaxel:cn-abc123", "user_b")).toBeNull();
    expect(mocks.getProvider).toHaveBeenCalledWith("blaxel");
    expect(mocks.connect).toHaveBeenCalledWith("cn-abc123");
  });

  it("serves a Blaxel sandbox to the user who owns it", async () => {
    vi.stubEnv("BL_API_KEY", "bl_key");
    vi.stubEnv("BL_WORKSPACE", "workspace");
    const sandbox = { ...fakeSandbox("cn-abc456", "user_a"), provider: "blaxel" } as Sandbox;
    mocks.connect.mockResolvedValue(sandbox);

    expect(await getOwnedSandbox("blaxel:cn-abc456", "user_a")).toBe(sandbox);
    expect(mocks.getProvider).toHaveBeenCalledWith("blaxel");
    expect(mocks.connect).toHaveBeenCalledWith("cn-abc456");
    forgetSandbox("blaxel:cn-abc456");
  });

  it("reads an unprefixed id as E2B's even when another provider comes first, so open previews keep working", async () => {
    mocks.config.mockReturnValue({ primary: "other" as ProviderId, fallbacks: ["e2b"], configured: { e2b: true } });
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_3", "user_a"));

    expect(await getOwnedSandbox("sbx_3", "user_a")).not.toBeNull();
    expect(mocks.getProvider).toHaveBeenCalledWith("e2b");
    expect(mocks.connect).toHaveBeenCalledWith("sbx_3");
    forgetSandbox("sbx_3");
  });

  it("caches one entry per sandbox whether or not the id carries the prefix", async () => {
    const sandbox = fakeSandbox("sbx_1");
    const reinstall = vi.fn();
    rememberSandbox(sandbox, "user_a", reinstall);

    expect(await getOwnedSandbox("e2b:sbx_1", "user_a")).toBe(sandbox);
    expect(requestReinstall("e2b:sbx_1")).toBe(true);
    expect(reinstall).toHaveBeenCalledOnce();
    forgetSandbox("e2b:sbx_1");
    expect(requestReinstall("sbx_1")).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("answers a sandbox the provider no longer has like an unknown id, and rejects on any other failure", async () => {
    mocks.connect.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
    expect(await getOwnedSandbox("sbx_4", "user_a")).toBeNull();

    const expired = fakeSandbox("sbx_4", "user_a");
    vi.mocked(expired.info).mockRejectedValueOnce(new SandboxNotFoundError("gone"));
    mocks.connect.mockResolvedValueOnce(expired);
    expect(await getOwnedSandbox("sbx_4", "user_a")).toBeNull();

    mocks.connect.mockRejectedValueOnce(new SandboxRateLimitError("slow down"));
    await expect(getOwnedSandbox("sbx_4", "user_a")).rejects.toBeInstanceOf(SandboxRateLimitError);
  });

  it("reconnects after the sandbox is forgotten", async () => {
    rememberSandbox(fakeSandbox("sbx_1"), "user_a");
    forgetSandbox("sbx_1");
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_1", "user_a"));

    await getOwnedSandbox("sbx_1", "user_a");

    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("hands a reinstall to the instance that booted the sandbox", () => {
    const reinstall = vi.fn();
    rememberSandbox(fakeSandbox("sbx_1"), "user_a", reinstall);

    expect(requestReinstall("sbx_1")).toBe(true);
    expect(reinstall).toHaveBeenCalledTimes(1);
  });

  it("waits for the stream install to drain before acknowledging a sync (#774)", async () => {
    let finish = () => {};
    const installed = new Promise<void>((resolve) => { finish = resolve; });
    rememberSandbox(fakeSandbox("sbx_1"), "user_a", vi.fn(), () => installed);
    expect(requestReinstall("sbx_1")).toBe(true);
    let acknowledged = false;
    const waiting = waitForReinstall("sbx_1").then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await waiting;
    expect(acknowledged).toBe(true);
  });

  it("reports a reinstall it cannot hand off", async () => {
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_1", "user_a"));
    await getOwnedSandbox("sbx_1", "user_a");

    expect(requestReinstall("sbx_1")).toBe(false);
    expect(requestReinstall("sbx_unknown")).toBe(false);
  });

  it("stops handing reinstalls to a boot stream that has ended (#492)", async () => {
    const sandbox = fakeSandbox("sbx_1");
    const reinstall = vi.fn();
    rememberSandbox(sandbox, "user_a", reinstall);
    rememberSandbox(sandbox, "user_a");

    expect(requestReinstall("sbx_1")).toBe(false);
    expect(reinstall).not.toHaveBeenCalled();
    expect(await getOwnedSandbox("sbx_1", "user_a")).toBe(sandbox);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
