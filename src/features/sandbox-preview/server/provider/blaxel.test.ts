import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CredentialsError extends Error {}
  class ResponseError extends Error {
    constructor(
      readonly status: number,
      readonly data: unknown = {},
    ) {
      super(`HTTP ${status}`);
    }
  }
  class SandboxCreationTimeoutError extends Error {
    readonly status = 408;
    readonly code = "CREATION_TIMEOUT";
  }
  type Body = Record<string, unknown> | undefined;
  const isStatus = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
  // The error helpers as @blaxel/core 0.3.40 reads them (common/error-types.js): the
  // error, its `error` and `data`, and each of those's `error`.
  const candidates = (error: unknown) =>
    [error, (error as Body)?.error, (error as Body)?.data].flatMap((body) => [body, (body as Body)?.error]) as Body[];
  return {
    errors: { CredentialsError, ResponseError, SandboxCreationTimeoutError },
    helpers: {
      getBlaxelErrorStatus: (error: unknown) =>
        candidates(error).flatMap((body) => [body?.status, body?.status_code, body?.code]).find(isStatus),
      getBlaxelErrorCode: (error: unknown) =>
        candidates(error).map((body) => body?.code).find((code) => typeof code === "string" || typeof code === "number"),
      getBlaxelErrorMessage: (error: unknown) =>
        candidates(error).map((body) => (typeof body === "string" ? body : body?.message)).find((message) => typeof message === "string" && message),
      isGatewayTimeout: (error: unknown) => error instanceof ResponseError && error.status === 504,
    },
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    updateLifecycle: vi.fn(),
  };
});

vi.mock("@blaxel/core", () => ({
  ...mocks.errors,
  ...mocks.helpers,
  MAX_CREATION_TIMEOUT_SECONDS: 50,
  SandboxInstance: {
    create: mocks.create,
    get: mocks.get,
    list: mocks.list,
    delete: mocks.delete,
    updateLifecycle: mocks.updateLifecycle,
  },
}));

import { createBlaxelProvider, fromBlaxelError, newSandboxName } from "./blaxel";
import { SandboxConfigError, SandboxNotFoundError, SandboxRateLimitError, SandboxTimeoutError } from "./types";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const instance = ({
  name = "cn-abc", labels = {} as Record<string, string>, status = "DEPLOYED", endAt = NOW + 60_000,
  createdAt = iso(NOW - 10 * 60_000) as string | null,
} = {}) => ({
  metadata: { name, labels, createdAt: createdAt ?? undefined },
  status,
  spec: { lifecycle: { expirationPolicies: [{ type: "date", value: iso(endAt), action: "delete" }] } },
  expiresIn: undefined,
});

const page = (data: unknown[], next: unknown = null) => ({ data, hasMore: next !== null, nextPage: vi.fn().mockResolvedValue(next) });

const provider = createBlaxelProvider();

describe("Blaxel provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
    delete process.env.BLAXEL_IMAGE;
    delete process.env.BL_REGION;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names sandboxes within Blaxel's and the public id's charset", () => {
    expect(newSandboxName()).toMatch(/^cn-[a-z0-9]{20}$/);
    expect(newSandboxName()).not.toBe(newSandboxName());
  });

  it("creates with the image, memory, region, preview port, labels and a date policy, capping the creation timeout", async () => {
    process.env.BLAXEL_IMAGE = " my-node22 ";
    process.env.BL_REGION = "eu-lon-1";
    const metadata = { userId: "user_1", projectId: "p1" };
    mocks.create.mockImplementation(async ({ name }) => instance({ name, labels: metadata }));

    const sandbox = await provider.create({ timeoutMs: 600_000, requestTimeoutMs: 90_000, metadata });

    const [config, options] = mocks.create.mock.calls[0];
    expect(config).toEqual({
      name: expect.stringMatching(/^cn-[a-z0-9]{20}$/),
      image: "my-node22",
      memory: 4096,
      region: "eu-lon-1",
      ports: [{ name: "preview", target: 4000 }],
      labels: metadata,
      lifecycle: { expirationPolicies: [{ type: "date", value: iso(NOW + 600_000), action: "delete" }] },
    });
    expect(options).toEqual({ timeout: 50 });
    expect(sandbox).toMatchObject({ provider: "blaxel", id: config.name });
  });

  it("defaults the image and region, rounds the creation timeout up and lets an explicit image win", async () => {
    mocks.create.mockImplementation(async ({ name }) => instance({ name }));

    await provider.create({ timeoutMs: 1, requestTimeoutMs: 1_500, metadata: {} });
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ image: "codenaya-node22", region: "us-was-1" }), { timeout: 2 });

    await provider.create({ image: "other", timeoutMs: 1, metadata: {} });
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ image: "other" }), { timeout: 30 });
  });

  it("throws on its own deadline and deletes the sandbox the create still makes", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.create.mockImplementation(({ name }) => new Promise((resolve) => (finish = () => resolve(instance({ name })))));
    mocks.delete.mockResolvedValue({});

    const rejection = provider.create({ timeoutMs: 1, requestTimeoutMs: 5_000, metadata: {} });
    const expectation = expect(rejection).rejects.toBeInstanceOf(SandboxTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
    expect(mocks.delete).not.toHaveBeenCalled();

    finish(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.delete).toHaveBeenCalledWith(mocks.create.mock.calls[0][0].name);
  });

  it("maps Blaxel's own creation timeout without a delete: it already released the sandbox", async () => {
    mocks.create.mockRejectedValue(new mocks.errors.SandboxCreationTimeoutError("not ready"));

    await expect(provider.create({ timeoutMs: 1, requestTimeoutMs: 5_000, metadata: {} })).rejects.toBeInstanceOf(SandboxTimeoutError);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("rejects and deletes a sandbox whose labels did not survive the create", async () => {
    mocks.create.mockImplementation(async ({ name }) => instance({ name, labels: { userId: "user1" } }));
    mocks.delete.mockResolvedValue({});

    const rejection = provider.create({ timeoutMs: 1, metadata: { userId: "user_1" } });
    await expect(rejection).rejects.toThrow("labels");
    await expect(rejection).rejects.toBeInstanceOf(SandboxConfigError);
    expect(mocks.delete).toHaveBeenCalledWith(mocks.create.mock.calls[0][0].name);
  });

  it.each([
    ["404", new mocks.errors.ResponseError(404)],
    ["raw IMAGE_NOT_FOUND", { code: "IMAGE_NOT_FOUND", message: "no image", status_code: 404 }],
    ["raw INVALID_REGION", { code: "INVALID_REGION", message: "bad region", status_code: 400 }],
  ])("maps a create-time %s to SandboxConfigError so the boot fails over", async (_, error) => {
    mocks.create.mockRejectedValue(error);

    await expect(provider.create({ timeoutMs: 1, metadata: {} })).rejects.toBeInstanceOf(SandboxConfigError);
  });

  it("bounds a request without requestTimeoutMs by 30 s, and 0 by none", async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));

    const rejection = provider.connect("cn-abc");
    const expectation = expect(rejection).rejects.toBeInstanceOf(SandboxTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;

    let settled = false;
    void provider.inspect!("cn-abc", { requestTimeoutMs: 0 }).finally(() => (settled = true)).catch(() => {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
  });

  it.each([
    ["55 min old: only to its hour", 55, NOW + 5 * 60_000],
    ["61 min old: not at all", 61, undefined],
    ["of unknown age: not at all", undefined, undefined],
  ])("extends a sandbox %s", async (_, ageMinutes, endAt) => {
    mocks.get.mockResolvedValue(instance({
      endAt: NOW + 60_000, createdAt: ageMinutes === undefined ? null : iso(NOW - ageMinutes * 60_000),
    }));
    mocks.updateLifecycle.mockResolvedValue(instance());

    await provider.connect("cn-abc", { timeoutMs: 10 * 60_000 });

    if (endAt === undefined) expect(mocks.updateLifecycle).not.toHaveBeenCalled();
    else expect(mocks.updateLifecycle).toHaveBeenCalledWith("cn-abc", { expirationPolicies: [{ type: "date", value: iso(endAt), action: "delete" }] });
  });

  it("extends the lifetime on connect but never shortens it", async () => {
    mocks.get.mockResolvedValue(instance({ endAt: NOW + 60_000 }));
    mocks.updateLifecycle.mockResolvedValue(instance({ endAt: NOW + 120_000 }));

    expect((await provider.connect("cn-abc", { timeoutMs: 120_000 })).id).toBe("cn-abc");
    expect(mocks.updateLifecycle).toHaveBeenCalledWith("cn-abc", {
      expirationPolicies: [{ type: "date", value: iso(NOW + 120_000), action: "delete" }],
    });

    mocks.updateLifecycle.mockClear();
    await provider.connect("cn-abc", { timeoutMs: 30_000 });
    await provider.connect("cn-abc");
    expect(mocks.updateLifecycle).not.toHaveBeenCalled();
  });

  it("inspects a running sandbox with a read only", async () => {
    mocks.get.mockResolvedValue(instance({ status: "DEPLOYING" }));

    expect((await provider.inspect!("cn-abc")).id).toBe("cn-abc");
    expect(mocks.get).toHaveBeenCalledWith("cn-abc");
    expect(mocks.updateLifecycle).not.toHaveBeenCalled();
  });

  it.each([
    ["terminated", instance({ status: "TERMINATED" })],
    ["failed", instance({ status: "FAILED" })],
    ["expired", instance({ endAt: NOW })],
  ])("rejects a %s sandbox on inspect and connect", async (_, sandbox) => {
    mocks.get.mockResolvedValue(sandbox);

    await expect(provider.inspect!("cn-abc")).rejects.toBeInstanceOf(SandboxNotFoundError);
    await expect(provider.connect("cn-abc", { timeoutMs: 1 })).rejects.toBeInstanceOf(SandboxNotFoundError);
    expect(mocks.updateLifecycle).not.toHaveBeenCalled();
  });

  it("lists by the longest label value, matching every label exactly and dropping expired sandboxes", async () => {
    const metadata = { userId: "user_1", purpose: "preview" };
    const mine = instance({ name: "cn-1", labels: { ...metadata, projectId: "p1" } });
    mocks.list.mockResolvedValue(page([
      mine,
      instance({ name: "cn-2", labels: { userId: "user_10", purpose: "preview" } }),
      instance({ name: "cn-3", labels: { userId: "user_1" } }),
      instance({ name: "cn-4", labels: metadata, endAt: NOW - 1 }),
    ]));

    expect(await provider.list({ metadata })).toEqual([
      { id: "cn-1", metadata: { ...metadata, projectId: "p1" }, endAt: new Date(NOW + 60_000) },
    ]);
    expect(mocks.list).toHaveBeenCalledWith({ q: "preview", status: "DEPLOYING,DEPLOYED", limit: 200, sort: "createdAt:desc" });
  });

  it("follows pages until the limit and throws past five pages rather than undercount", async () => {
    const labels = { userId: "u1" };
    const third = page([instance({ name: "cn-3", labels })], page([instance({ name: "cn-4", labels })]));
    mocks.list.mockResolvedValue(page([instance({ name: "cn-1", labels })], page([instance({ name: "cn-2", labels })], third)));

    expect((await provider.list({ metadata: labels, limit: 2 })).map(({ id }) => id)).toEqual(["cn-1", "cn-2"]);
    expect(third.nextPage).not.toHaveBeenCalled();
    expect((await provider.list({ metadata: labels })).map(({ id }) => id)).toEqual(["cn-1", "cn-2", "cn-3", "cn-4"]);

    const endless = { data: [instance({ labels })], hasMore: true, nextPage: vi.fn() };
    endless.nextPage.mockResolvedValue(endless);
    mocks.list.mockResolvedValue(endless);
    await expect(provider.list({ metadata: labels })).rejects.toThrow("refusing to undercount");
    expect(endless.nextPage).toHaveBeenCalledTimes(4);
  });

  it("kills by name and answers false when the sandbox was already gone", async () => {
    mocks.delete.mockResolvedValueOnce({}).mockRejectedValueOnce(new mocks.errors.ResponseError(404))
      .mockRejectedValueOnce({ code: "SANDBOX_DELETION_IN_PROGRESS", message: "deleting", status_code: 409 });

    expect(await provider.kill("cn-abc")).toBe(true);
    expect(await provider.kill("cn-abc")).toBe(false);
    expect(await provider.kill("cn-abc")).toBe(false);
    expect(mocks.delete).toHaveBeenCalledWith("cn-abc");
  });

  it.each([
    ["CredentialsError", new mocks.errors.CredentialsError("no key"), SandboxConfigError],
    ["401", new mocks.errors.ResponseError(401), SandboxConfigError],
    ["403", new mocks.errors.ResponseError(403), SandboxConfigError],
    ["raw TOKEN_REVOKED", { error: { code: "TOKEN_REVOKED", message: "revoked", status: 401 } }, SandboxConfigError],
    ["raw WORKSPACE_REQUIRED", { code: "WORKSPACE_REQUIRED", message: "pick one", status_code: 400 }, SandboxConfigError],
    ["402", new mocks.errors.ResponseError(402), SandboxRateLimitError],
    ["429", new mocks.errors.ResponseError(429), SandboxRateLimitError],
    ["raw QUOTA_EXCEEDED", { code: "QUOTA_EXCEEDED", message: "quota", status_code: 400 }, SandboxRateLimitError],
    ["SandboxCreationTimeoutError", new mocks.errors.SandboxCreationTimeoutError("slow"), SandboxTimeoutError],
    ["gateway 504", new mocks.errors.ResponseError(504), SandboxTimeoutError],
    ["404", new mocks.errors.ResponseError(404), SandboxNotFoundError],
    ["raw generic 404", { error: "sandbox not found", code: 404 }, SandboxNotFoundError],
    ["raw SANDBOX_DELETED", { code: "SANDBOX_DELETED", message: "deleted", status_code: 409 }, SandboxNotFoundError],
  ])("maps %s to the seam's error, keeping the message and cause", (_, error, Expected) => {
    const mapped = fromBlaxelError(error, "sandbox");

    expect(mapped).toBeInstanceOf(Expected);
    expect(mapped).toMatchObject({ message: mocks.helpers.getBlaxelErrorMessage(error) ?? (error as Error).message, cause: error });
  });

  it("rethrows a file-level 404 and other errors as they are, and wraps raw bodies in an Error", () => {
    const notFound = new mocks.errors.ResponseError(404);
    expect(fromBlaxelError(notFound)).toBe(notFound);
    const boom = new Error("boom");
    expect(fromBlaxelError(boom, "sandbox")).toBe(boom);
    const raw = { error: "internal", code: 500 };
    expect(fromBlaxelError(raw)).toMatchObject({ message: "internal", cause: raw });
    expect(fromBlaxelError(raw)).toBeInstanceOf(Error);
  });

  it("maps errors thrown by provider calls", async () => {
    mocks.get.mockRejectedValue({ error: { code: "WORKLOAD_NOT_FOUND", message: "gone", status: 404 } });
    await expect(provider.connect("cn-abc")).rejects.toBeInstanceOf(SandboxNotFoundError);
    mocks.list.mockRejectedValue(new mocks.errors.ResponseError(429));
    await expect(provider.list({})).rejects.toBeInstanceOf(SandboxRateLimitError);
  });

  describe("sandbox", () => {
    const connect = async () => {
      const blaxel = {
        ...instance(),
        process: { exec: vi.fn() },
        fs: { writeTree: vi.fn(), writeBinary: vi.fn(), read: vi.fn(), readBinary: vi.fn() },
        previews: { createIfNotExists: vi.fn() },
      };
      mocks.get.mockResolvedValue(blaxel);
      return { blaxel, sandbox: await provider.connect("cn-abc") };
    };
    const done = (result: object) => ({ status: "completed", exitCode: 0, stdout: "", stderr: "", ...result });

    it("runs with cwd, envs and output callbacks, and resolves a non-zero exit as a result", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.process.exec.mockResolvedValue(done({ status: "failed", exitCode: 2, stdout: "out", stderr: "err" }));
      const onStdout = vi.fn();

      expect(await sandbox.run("npm install", { cwd: "/app", envs: { A: "1" }, timeoutMs: 1_500, onStdout })).toEqual({
        exitCode: 2, stdout: "out", stderr: "err",
      });
      expect(blaxel.process.exec).toHaveBeenCalledWith({
        command: "npm install", workingDir: "/app", env: { A: "1" }, waitForCompletion: true, timeout: 2,
        onStdout, onStderr: expect.any(Function),
      });
    });

    it("always streams, defaults to E2B's 60s and takes 0 as no limit", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.process.exec.mockResolvedValue(done({}));

      await sandbox.run("true");
      expect(blaxel.process.exec).toHaveBeenLastCalledWith(expect.objectContaining({
        timeout: 60, onStdout: expect.any(Function), onStderr: expect.any(Function),
      }));
      await sandbox.run("true", { timeoutMs: 0 });
      expect(blaxel.process.exec).toHaveBeenLastCalledWith(expect.objectContaining({ timeout: 0 }));
    });

    it("throws SandboxTimeoutError when its timeout killed the command, but not without one", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.process.exec.mockResolvedValue(done({ status: "killed", exitCode: 137 }));

      await expect(sandbox.run("sleep 99", { timeoutMs: 1_000 })).rejects.toBeInstanceOf(SandboxTimeoutError);
      expect((await sandbox.run("sleep 99", { timeoutMs: 0 })).exitCode).toBe(137);
    });

    it("maps errors from the sandbox's calls", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.process.exec.mockRejectedValue(new mocks.errors.ResponseError(504));

      await expect(sandbox.run("npm test")).rejects.toBeInstanceOf(SandboxTimeoutError);
    });

    it("starts in the background with a numeric pid and no keepAlive or timeout", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.process.exec.mockResolvedValue({ pid: "42", status: "running" });

      expect(await sandbox.start("npm run dev", { cwd: "/app", envs: { A: "1" } })).toEqual({ pid: 42 });
      expect(blaxel.process.exec).toHaveBeenCalledWith({
        command: "npm run dev", workingDir: "/app", env: { A: "1" }, waitForCompletion: false, onStdout: undefined, onStderr: undefined,
      });
    });

    it("writes text in one tree request, bytes one by one, and skips an empty list", async () => {
      const { blaxel, sandbox } = await connect();
      const bytes = new Uint8Array([1, 2]).buffer;

      await sandbox.writeFiles([{ path: "/app/a.ts", data: "a" }, { path: "/app/b/c.ts", data: "c" }, { path: "/app/logo.png", data: bytes }]);
      await sandbox.writeFiles([]);

      expect(blaxel.fs.writeTree).toHaveBeenCalledTimes(1);
      expect(blaxel.fs.writeTree).toHaveBeenCalledWith([{ path: "app/a.ts", content: "a" }, { path: "app/b/c.ts", content: "c" }], "/");
      expect(blaxel.fs.writeBinary).toHaveBeenCalledTimes(1);
      expect(blaxel.fs.writeBinary).toHaveBeenCalledWith("/app/logo.png", new Uint8Array([1, 2]));
    });

    it("reads text, and bytes from a Blob, rethrowing a missing file as is", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.fs.read.mockResolvedValue("x");
      blaxel.fs.readBinary.mockResolvedValue(new Blob([new Uint8Array([7, 8])]));

      expect(await sandbox.readFile("/a", "text")).toBe("x");
      expect(await sandbox.readFile("/a", "bytes")).toEqual(new Uint8Array([7, 8]));
      const missing = new mocks.errors.ResponseError(404);
      blaxel.fs.read.mockRejectedValue(missing);
      await expect(sandbox.readFile("/gone", "text")).rejects.toBe(missing);
    });

    it("creates one public preview per port and retries after a failure", async () => {
      const { blaxel, sandbox } = await connect();
      blaxel.previews.createIfNotExists
        .mockRejectedValueOnce(new mocks.errors.ResponseError(500))
        .mockResolvedValue({ url: "https://abc.us-was-1.preview.bl.run" });

      await expect(sandbox.previewUrl(4000)).rejects.toThrow();
      expect(await sandbox.previewUrl(4000)).toBe("https://abc.us-was-1.preview.bl.run");
      expect(await sandbox.previewUrl(4000)).toBe("https://abc.us-was-1.preview.bl.run");
      expect(blaxel.previews.createIfNotExists).toHaveBeenCalledTimes(2);
      expect(blaxel.previews.createIfNotExists).toHaveBeenCalledWith({ port: 4000, name: "p4000", public: true });
    });

    it("reads fresh info from the labels and the date policy, and kills even when already gone", async () => {
      mocks.get.mockResolvedValueOnce(instance()).mockResolvedValueOnce(instance({ labels: { userId: "u1" }, endAt: NOW + 5_000 }));
      mocks.delete.mockRejectedValue(new mocks.errors.ResponseError(404));
      const sandbox = await provider.connect("cn-abc");

      expect(await sandbox.info()).toEqual({ metadata: { userId: "u1" }, endAt: new Date(NOW + 5_000) });
      await expect(sandbox.kill()).resolves.toBeUndefined();
    });
  });
});
