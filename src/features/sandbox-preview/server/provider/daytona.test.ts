import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class DaytonaError extends Error {}
  class DaytonaAuthenticationError extends DaytonaError {}
  class DaytonaForbiddenError extends DaytonaError {}
  class DaytonaAuthorizationError extends DaytonaForbiddenError {}
  class DaytonaBadRequestError extends DaytonaError {}
  class DaytonaValidationError extends DaytonaBadRequestError {}
  class DaytonaNotFoundError extends DaytonaError {}
  class DaytonaGoneError extends DaytonaError {}
  class DaytonaRateLimitError extends DaytonaError {}
  class DaytonaTimeoutError extends DaytonaError {
    sandboxId?: string;
  }
  class DaytonaQueueTimeoutError extends DaytonaTimeoutError {}
  class DaytonaConnectionError extends DaytonaError {}
  class DaytonaConnectionTimeoutError extends DaytonaConnectionError {}
  class DaytonaFileNotFoundError extends DaytonaNotFoundError {}
  class DaytonaFileAccessDeniedError extends DaytonaForbiddenError {}
  class DaytonaProcessNotFoundError extends DaytonaNotFoundError {}
  class DaytonaSessionEndedError extends DaytonaGoneError {}
  class DaytonaCommandAlreadyCompletedError extends DaytonaGoneError {}
  const create = vi.fn();
  const get = vi.fn();
  const list = vi.fn();
  return {
    errors: {
      DaytonaAuthenticationError, DaytonaBadRequestError, DaytonaValidationError, DaytonaForbiddenError, DaytonaAuthorizationError, DaytonaNotFoundError,
      DaytonaGoneError, DaytonaRateLimitError, DaytonaTimeoutError, DaytonaQueueTimeoutError,
      DaytonaConnectionTimeoutError, DaytonaFileNotFoundError, DaytonaFileAccessDeniedError,
      DaytonaProcessNotFoundError, DaytonaSessionEndedError, DaytonaCommandAlreadyCompletedError,
    },
    client: vi.fn<(config: unknown) => unknown>(() => ({ create, get, list })),
    create,
    get,
    list,
  };
});

vi.mock("@daytona/sdk", () => ({
  ...mocks.errors,
  Daytona: vi.fn(function (config: unknown) { return mocks.client(config); }),
}));

import { createDaytonaProvider, ttlMinutes, withDeadline } from "./daytona";
import {
  SandboxConfigError, SandboxNotFoundError, SandboxRateLimitError, SandboxTimeoutError,
} from "./types";

const AUTO_DESTROY_AT = "2099-01-01T00:00:00.000Z";

const fakeDaytonaSandbox = (overrides: Record<string, unknown> = {}) => ({
  id: "sbx-1",
  state: "started",
  labels: { userId: "u1", "code-toolbox-language": "python" },
  autoDestroyAt: AUTO_DESTROY_AT,
  getPreviewLink: vi.fn(async (port: number) => ({ url: `https://${port}-sbx-1.proxy.daytona.works`, token: "preview-token" })),
  setTtl: vi.fn<(minutes: number) => Promise<void>>(async () => {}),
  refreshData: vi.fn(async () => {}),
  delete: vi.fn<(timeout?: number) => Promise<void>>(async () => {}),
  ...overrides,
});

/** An SDK list iterator over `items`. */
const listOf = (items: unknown[]) => (async function* () { yield* items; })();

const provider = createDaytonaProvider("key_1");

describe("Daytona provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DAYTONA_SNAPSHOT;
    delete process.env.DAYTONA_API_URL;
    delete process.env.DAYTONA_TARGET;
  });

  it("builds one client per key and endpoint, always passing the endpoint", async () => {
    process.env.DAYTONA_TARGET = " eu ";
    mocks.get.mockResolvedValue(fakeDaytonaSandbox());
    const memo = createDaytonaProvider("key_memo");

    await memo.connect("sbx-1");
    await memo.connect("sbx-1");

    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(mocks.client).toHaveBeenCalledWith({
      apiKey: "key_memo", apiUrl: "https://app.daytona.io/api", target: "eu", requestTimeoutMs: 30_000,
    });
  });

  it("creates a public, ephemeral sandbox from DAYTONA_SNAPSHOT with labels, auto-stop off and a TTL", async () => {
    process.env.DAYTONA_SNAPSHOT = " my-snap ";
    mocks.create.mockResolvedValue(fakeDaytonaSandbox());
    const metadata = { userId: "u1", projectId: "p1" };

    const sandbox = await provider.create({ timeoutMs: 90_000, requestTimeoutMs: 5_000, metadata, localHostHeader: true });

    expect(mocks.create).toHaveBeenCalledWith(
      { snapshot: "my-snap", labels: metadata, public: true, autoStopInterval: 0, ephemeral: true, ttlMinutes: 2 },
      { timeout: 5 },
    );
    // A copy, because the SDK adds its language label to the object it is given.
    expect(mocks.create.mock.calls[0][0].labels).not.toBe(metadata);
    expect(sandbox).toMatchObject({ provider: "daytona", id: "sbx-1" });
  });

  it("creates from the default snapshot, and an explicit image wins", async () => {
    mocks.create.mockResolvedValue(fakeDaytonaSandbox());

    await provider.create({ timeoutMs: 1, metadata: {} });
    process.env.DAYTONA_SNAPSHOT = "other";
    await provider.create({ image: "snap-2", timeoutMs: 1, metadata: {} });

    expect(mocks.create.mock.calls[0][0]).toMatchObject({ snapshot: "codenaya-node22-v1" });
    expect(mocks.create.mock.calls[0][1]).toEqual({ timeout: undefined });
    expect(mocks.create.mock.calls[1][0]).toMatchObject({ snapshot: "snap-2" });
  });

  it.each([[0, 1], [1, 1], [60_001, 2], [60 * 60 * 1000, 60], [24 * 60 * 60 * 1000, 60]])(
    "cost guard: a %i ms lifetime is a %i minute TTL, never 0 (no TTL) or over an hour, with auto-stop off",
    async (timeoutMs, minutes) => {
      mocks.create.mockResolvedValue(fakeDaytonaSandbox());

      await provider.create({ timeoutMs, metadata: {} });

      expect(ttlMinutes(timeoutMs)).toBe(minutes);
      expect(mocks.create.mock.calls[0][0]).toMatchObject({ ttlMinutes: minutes, autoStopInterval: 0, ephemeral: true });
    },
  );

  it("cost guard: caps a session at one hour", () => {
    expect(provider.maxSessionMs).toBe(60 * 60 * 1000);
  });

  it("deletes a sandbox whose create it stopped waiting for", async () => {
    const daytona = fakeDaytonaSandbox();
    let finish: (sandbox: unknown) => void = () => {};
    mocks.create.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    await expect(provider.create({ timeoutMs: 1, metadata: {}, requestTimeoutMs: 10 })).rejects.toBeInstanceOf(SandboxTimeoutError);
    finish(daytona);

    await vi.waitFor(() => expect(daytona.delete).toHaveBeenCalled());
  });

  it("deletes the sandbox an SDK create timeout reports after the deadline", async () => {
    const daytona = fakeDaytonaSandbox({ id: "sbx-9" });
    let fail: (error: unknown) => void = () => {};
    mocks.create.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    mocks.get.mockResolvedValue(daytona);

    await expect(provider.create({ timeoutMs: 1, metadata: {}, requestTimeoutMs: 10 })).rejects.toBeInstanceOf(SandboxTimeoutError);
    fail(Object.assign(new mocks.errors.DaytonaTimeoutError("not started in time"), { sandboxId: "sbx-9" }));

    await vi.waitFor(() => expect(daytona.delete).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith("sbx-9");
  });

  it("deletes the sandbox an SDK create timeout left behind", async () => {
    const daytona = fakeDaytonaSandbox({ id: "sbx-9" });
    mocks.create.mockRejectedValue(Object.assign(new mocks.errors.DaytonaTimeoutError("create timed out"), { sandboxId: "sbx-9" }));
    mocks.get.mockResolvedValue(daytona);

    await expect(provider.create({ timeoutMs: 1, metadata: {} })).rejects.toBeInstanceOf(SandboxTimeoutError);

    await vi.waitFor(() => expect(daytona.delete).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith("sbx-9");
  });

  it.each([
    new mocks.errors.DaytonaValidationError("snapshot not found"),
    new mocks.errors.DaytonaNotFoundError("snapshot not found"),
  ])("treats a create's %o as config, so failover moves on", async (error) => {
    mocks.create.mockRejectedValue(error);

    await expect(provider.create({ timeoutMs: 1, metadata: {} })).rejects.toBeInstanceOf(SandboxConfigError);
  });

  describe("connect's lifetime extension", () => {
    const NOW = Date.parse("2026-11-19T12:00:00.000Z");
    const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      ["extends a sandbox with 2 min left", -10, 2, 30, 30],
      ["never shortens one with 50 min left", -10, 50, 5, undefined],
      ["caps it at an hour from creation", -55, 2, 30, 5],
      ["never extends one created over an hour ago", -61, 2, 30, undefined],
      ["caps a long request at the hour", -10, 2, 5 * 60, 50],
    ])("%s", async (_name, createdAgo, left, timeoutMin, expected) => {
      const daytona = fakeDaytonaSandbox({ createdAt: minutes(createdAgo), autoDestroyAt: minutes(left) });
      mocks.get.mockResolvedValue(daytona);

      expect((await provider.connect("sbx-1", { timeoutMs: timeoutMin * 60_000 })).id).toBe("sbx-1");

      expect(mocks.get).toHaveBeenCalledWith("sbx-1");
      if (expected === undefined) expect(daytona.setTtl).not.toHaveBeenCalled();
      else expect(daytona.setTtl).toHaveBeenCalledWith(expected);
    });

    it("never extends without a creation time or a timeout", async () => {
      const daytona = fakeDaytonaSandbox({ createdAt: undefined, autoDestroyAt: minutes(1) });
      mocks.get.mockResolvedValue(daytona);

      await provider.connect("sbx-1", { timeoutMs: 30 * 60_000 });
      await provider.connect("sbx-1");

      expect(daytona.setTtl).not.toHaveBeenCalled();
    });
  });

  it.each(["stopped", "destroying", "error"])("treats a %s sandbox as gone on connect", async (state) => {
    const daytona = fakeDaytonaSandbox({ state });
    mocks.get.mockResolvedValue(daytona);

    await expect(provider.connect("sbx-1", { timeoutMs: 60_000 })).rejects.toBeInstanceOf(SandboxNotFoundError);
    expect(daytona.setTtl).not.toHaveBeenCalled();
  });

  it("inspects a running sandbox without touching its TTL", async () => {
    const daytona = fakeDaytonaSandbox();
    mocks.get.mockResolvedValue(daytona);

    expect((await provider.inspect!("sbx-1")).id).toBe("sbx-1");
    expect(daytona.setTtl).not.toHaveBeenCalled();
    expect(daytona.refreshData).not.toHaveBeenCalled();
  });

  it.each([
    ["stopped", AUTO_DESTROY_AT],
    ["started", "2000-01-01T00:00:00.000Z"],
    ["started", undefined],
  ])("does not inspect a %s sandbox that ends at %s", async (state, autoDestroyAt) => {
    mocks.get.mockResolvedValue(fakeDaytonaSandbox({ state, autoDestroyAt }));

    await expect(provider.inspect!("sbx-1")).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  it("lists started sandboxes by labels, checks them again, stops at the limit and drops the SDK's own label", async () => {
    mocks.list.mockReturnValue(listOf([
      fakeDaytonaSandbox(),
      // A looser server-side match is dropped, and doesn't count toward the limit.
      fakeDaytonaSandbox({ id: "sbx-other", labels: { userId: "u2" } }),
      fakeDaytonaSandbox({ id: "sbx-2", autoDestroyAt: undefined }),
      fakeDaytonaSandbox({ id: "sbx-3" }),
    ]));

    const listed = await provider.list({ metadata: { userId: "u1" }, limit: 2 });

    expect(mocks.list).toHaveBeenCalledWith({ labels: { userId: "u1" }, states: ["started"], limit: 2 });
    expect(listed).toEqual([
      { id: "sbx-1", metadata: { userId: "u1" }, endAt: new Date(AUTO_DESTROY_AT) },
      { id: "sbx-2", metadata: { userId: "u1" }, endAt: new Date(0) },
    ]);
  });

  it("lists every page without a limit", async () => {
    mocks.list.mockReturnValue(listOf([fakeDaytonaSandbox(), fakeDaytonaSandbox({ id: "sbx-2" })]));

    expect(await provider.list({})).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledWith({ labels: undefined, states: ["started"], limit: undefined });
  });

  it("kills by id, and says false when the sandbox is already gone", async () => {
    const daytona = fakeDaytonaSandbox();
    mocks.get.mockResolvedValueOnce(daytona);

    expect(await provider.kill("sbx-1", { requestTimeoutMs: 1_500 })).toBe(true);
    expect(daytona.delete).toHaveBeenCalledWith(2);
    mocks.get.mockRejectedValueOnce(new mocks.errors.DaytonaNotFoundError("Sandbox not found"));
    expect(await provider.kill("sbx-1")).toBe(false);
    mocks.get.mockResolvedValueOnce(fakeDaytonaSandbox({ delete: vi.fn().mockRejectedValue(new mocks.errors.DaytonaGoneError("gone")) }));
    expect(await provider.kill("sbx-1")).toBe(false);
  });

  it.each(["destroying", "destroyed"])("says false for a %s sandbox without deleting it again", async (state) => {
    const daytona = fakeDaytonaSandbox({ state });
    mocks.get.mockResolvedValue(daytona);

    expect(await provider.kill("sbx-1")).toBe(false);
    expect(daytona.delete).not.toHaveBeenCalled();
  });

  it.each([
    [new mocks.errors.DaytonaAuthenticationError("bad key"), SandboxConfigError],
    [new mocks.errors.DaytonaForbiddenError("forbidden"), SandboxConfigError],
    [new mocks.errors.DaytonaAuthorizationError("not allowed"), SandboxConfigError],
    [new mocks.errors.DaytonaRateLimitError("slow down"), SandboxRateLimitError],
    [new mocks.errors.DaytonaTimeoutError("create timed out"), SandboxTimeoutError],
    [new mocks.errors.DaytonaQueueTimeoutError("no runner"), SandboxTimeoutError],
    [new mocks.errors.DaytonaConnectionTimeoutError("read timeout"), SandboxTimeoutError],
    [new mocks.errors.DaytonaNotFoundError("Sandbox not found"), SandboxNotFoundError],
    [new mocks.errors.DaytonaGoneError("Sandbox destroyed"), SandboxNotFoundError],
  ])("maps %o to the seam's error", async (error, Expected) => {
    mocks.get.mockRejectedValue(error);

    const rejection = provider.connect("sbx-1");

    await expect(rejection).rejects.toBeInstanceOf(Expected);
    await expect(rejection).rejects.toMatchObject({ message: error.message, cause: error });
  });

  it.each([
    new mocks.errors.DaytonaFileNotFoundError("no such file"),
    new mocks.errors.DaytonaFileAccessDeniedError("denied"),
    new mocks.errors.DaytonaProcessNotFoundError("no process"),
    new mocks.errors.DaytonaSessionEndedError("session ended"),
    new mocks.errors.DaytonaCommandAlreadyCompletedError("done"),
    new Error("boom"),
  ])("passes %o through: it is not the sandbox gone or the account refused", async (error) => {
    mocks.get.mockRejectedValue(error);

    await expect(provider.connect("sbx-1")).rejects.toBe(error);
  });

  it("times a call out with SandboxTimeoutError at requestTimeoutMs", async () => {
    mocks.create.mockReturnValue(new Promise(() => {}));

    await expect(provider.create({ timeoutMs: 1, metadata: {}, requestTimeoutMs: 10 })).rejects.toBeInstanceOf(SandboxTimeoutError);
    await expect(withDeadline(new Promise(() => {}), 10)).rejects.toThrow("Daytona request timed out after 10 ms");
    expect(await withDeadline(Promise.resolve("ok"))).toBe("ok");
  });

  describe("sandbox", () => {
    const connect = async (overrides?: Record<string, unknown>) => {
      const daytona = fakeDaytonaSandbox(overrides);
      mocks.get.mockResolvedValue(daytona);
      return { daytona, sandbox: await provider.connect("sbx-1") };
    };

    it("returns the public preview URL, never its token", async () => {
      const { daytona, sandbox } = await connect();

      const url = await sandbox.previewUrl(4000);

      expect(url).toBe("https://4000-sbx-1.proxy.daytona.works");
      expect(url).not.toContain("preview-token");
      expect(daytona.getPreviewLink).toHaveBeenCalledWith(4000);
    });

    it("refreshes info, and kills itself", async () => {
      const { daytona, sandbox } = await connect();

      expect(await sandbox.info()).toEqual({ metadata: { userId: "u1" }, endAt: new Date(AUTO_DESTROY_AT) });
      expect(daytona.refreshData).toHaveBeenCalled();
      await sandbox.kill({ requestTimeoutMs: 5_000 });
      expect(daytona.delete).toHaveBeenCalledWith(5);
      // Already gone resolves, as E2B's kill does.
      daytona.delete.mockRejectedValueOnce(new mocks.errors.DaytonaNotFoundError("gone"));
      await expect(sandbox.kill()).resolves.toBeUndefined();
      expect(sandbox.listCommands).toBeUndefined();
      expect(sandbox.killCommand).toBeUndefined();
    });
  });
});
