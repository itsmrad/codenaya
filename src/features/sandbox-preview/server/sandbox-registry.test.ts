import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("e2b", () => ({ Sandbox: { connect: mocks.connect } }));

import type { Sandbox } from "e2b";

import {
  forgetSandbox,
  getOwnedSandbox,
  rememberSandbox,
} from "./sandbox-registry";

const fakeSandbox = (sandboxId: string, ownerId?: string) =>
  ({
    sandboxId,
    getInfo: vi.fn().mockResolvedValue({ metadata: { userId: ownerId } }),
  }) as unknown as Sandbox;

describe("sandbox registry", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
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
    expect(sandbox.getInfo).toHaveBeenCalledTimes(1);
  });

  it("does not cache a sandbox the caller does not own", async () => {
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_1", "user_a"));

    expect(await getOwnedSandbox("sbx_1", "user_b")).toBeNull();
    expect(await getOwnedSandbox("sbx_1", "user_b")).toBeNull();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("reconnects after the sandbox is forgotten", async () => {
    rememberSandbox(fakeSandbox("sbx_1"), "user_a");
    forgetSandbox("sbx_1");
    mocks.connect.mockResolvedValue(fakeSandbox("sbx_1", "user_a"));

    await getOwnedSandbox("sbx_1", "user_a");

    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
});
