import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), getProvider: vi.fn() }));

vi.mock("./provider/registry", () => ({ getProvider: mocks.getProvider }));

import type { Sandbox } from "./provider/types";

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
    mocks.connect.mockReset();
    mocks.getProvider.mockReset().mockReturnValue({ connect: mocks.connect });
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

  it.each(["blaxel:sbx_1", "e2b:", "../sbx", "sbx 1"])("refuses a malformed or unknown-provider id %j without connecting", async (id) => {
    expect(await getOwnedSandbox(id, "user_a")).toBeNull();
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
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
