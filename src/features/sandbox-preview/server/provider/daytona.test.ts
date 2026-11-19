import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class DaytonaError extends Error {}
  class DaytonaAuthenticationError extends DaytonaError {}
  class DaytonaForbiddenError extends DaytonaError {}
  class DaytonaAuthorizationError extends DaytonaForbiddenError {}
  class DaytonaNotFoundError extends DaytonaError {}
  class DaytonaGoneError extends DaytonaError {}
  class DaytonaRateLimitError extends DaytonaError {}
  class DaytonaTimeoutError extends DaytonaError {}
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
      DaytonaAuthenticationError, DaytonaForbiddenError, DaytonaAuthorizationError, DaytonaNotFoundError,
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

import { DEFAULT_DAYTONA_SNAPSHOT, createDaytonaProvider, ttlMinutes, withDeadline } from "./daytona";
import {
  SandboxConfigError, SandboxExitError, SandboxNotFoundError, SandboxRateLimitError, SandboxTimeoutError,
} from "./types";

const AUTO_DESTROY_AT = "2099-01-01T00:00:00.000Z";

type Request = { command: string; runAsync?: boolean };
type ExecResult = { cmdId: string; exitCode?: number; stdout?: string; stderr?: string };
type OnChunk = (chunk: string) => void;

const fakeDaytonaSandbox = (overrides: Record<string, unknown> = {}) => ({
  id: "sbx-1",
  state: "started",
  labels: { userId: "u1", "code-toolbox-language": "python" },
  autoDestroyAt: AUTO_DESTROY_AT,
  process: {
    createSession: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
    executeSessionCommand: vi.fn<(sessionId: string, request: Request, timeout?: number) => Promise<ExecResult>>(
      async () => ({ cmdId: "cmd-1", exitCode: 0, stdout: "", stderr: "" }),
    ),
    getSessionCommand: vi.fn<(sessionId: string, cmdId: string) => Promise<{ id: string; exitCode?: number }>>(
      async () => ({ id: "cmd-1", exitCode: 0 }),
    ),
    getSessionCommandLogs: vi.fn<(sessionId: string, cmdId: string, onStdout: OnChunk, onStderr: OnChunk) => Promise<void>>(
      async () => {},
    ),
    deleteSession: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
  },
  fs: {
    uploadFiles: vi.fn<(files: { source: Buffer; destination: string }[], timeout?: number) => Promise<void>>(async () => {}),
    downloadFile: vi.fn<(path: string, timeout?: number) => Promise<Buffer>>(async () => Buffer.from("")),
  },
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
    expect(mocks.client).toHaveBeenCalledWith({ apiKey: "key_memo", apiUrl: "https://app.daytona.io/api", target: "eu" });
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

    expect(DEFAULT_DAYTONA_SNAPSHOT).toBe("codenaya-node22-v1");
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
      expect(provider.maxSessionMs).toBe(60 * 60 * 1000);
    },
  );

  it("connects to a started sandbox and re-anchors its TTL, bounded to an hour", async () => {
    const daytona = fakeDaytonaSandbox();
    mocks.get.mockResolvedValue(daytona);

    expect((await provider.connect("sbx-1", { timeoutMs: 30 * 60_000 })).id).toBe("sbx-1");
    expect(mocks.get).toHaveBeenCalledWith("sbx-1");
    expect(daytona.setTtl).toHaveBeenCalledWith(30);
    await provider.connect("sbx-1", { timeoutMs: 5 * 60 * 60_000 });
    expect(daytona.setTtl).toHaveBeenLastCalledWith(60);
    await provider.connect("sbx-1");
    expect(daytona.setTtl).toHaveBeenCalledTimes(2);
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

  it("lists started sandboxes by labels, stops at the limit and drops the SDK's own label", async () => {
    mocks.list.mockReturnValue(listOf([
      fakeDaytonaSandbox(),
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
    mocks.create.mockRejectedValue(error);

    const rejection = provider.create({ timeoutMs: 1, metadata: {} });

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
      expect(sandbox.listCommands).toBeUndefined();
      expect(sandbox.killCommand).toBeUndefined();
    });

    describe("run", () => {
      it("sets cwd and envs with quotes in them, as bash reads them back", async () => {
        const { daytona, sandbox } = await connect();
        const cwd = mkdtempSync(join(tmpdir(), "it's "));
        try {
          await sandbox.run(`printf '%s|%s' "$PWD" "$A"`, { cwd, envs: { A: "x'y $HOME" } });

          const { command } = daytona.process.executeSessionCommand.mock.calls[0][1];
          expect(spawnSync("bash", ["-c", command], { encoding: "utf8" }).stdout).toBe(`${cwd}|x'y $HOME`);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });

      it("resolves a non-zero exit with separate stdout and stderr, in its own session", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockResolvedValue({ cmdId: "cmd-1", exitCode: 2, stdout: "out", stderr: "err" });

        expect(await sandbox.run("npm install")).toEqual({ exitCode: 2, stdout: "out", stderr: "err" });
        const [sessionId, request, timeout] = daytona.process.executeSessionCommand.mock.calls[0];
        expect(daytona.process.createSession).toHaveBeenCalledWith(sessionId);
        expect(request).toEqual({ command: expect.stringContaining("npm install") });
        // E2B's default command timeout.
        expect(timeout).toBe(60);
        expect(daytona.process.deleteSession).toHaveBeenCalledWith(sessionId);
      });

      it("turns timeoutMs into seconds, maps the SDK timeout and still deletes the session", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockRejectedValue(new mocks.errors.DaytonaConnectionTimeoutError("timeout of 2000ms exceeded"));

        await expect(sandbox.run("sleep 99", { timeoutMs: 1_500 })).rejects.toBeInstanceOf(SandboxTimeoutError);
        expect(daytona.process.executeSessionCommand.mock.calls[0][2]).toBe(2);
        expect(daytona.process.deleteSession).toHaveBeenCalled();
        await sandbox.run("true", { timeoutMs: 0 }).catch(() => {});
        expect(daytona.process.executeSessionCommand.mock.calls[1][2]).toBeUndefined();
      });

      it("streams output to the callbacks and resolves with all of it and the exit code", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockResolvedValue({ cmdId: "cmd-9" });
        daytona.process.getSessionCommandLogs.mockImplementation(async (_sessionId, _cmdId, onStdout, onStderr) => {
          onStdout("a");
          onStderr("b");
          onStdout("c");
        });
        daytona.process.getSessionCommand.mockResolvedValue({ id: "cmd-9", exitCode: 3 });
        const onStdout = vi.fn();
        const onStderr = vi.fn();

        expect(await sandbox.run("npm run build", { onStdout, onStderr })).toEqual({ exitCode: 3, stdout: "ac", stderr: "b" });
        expect(daytona.process.executeSessionCommand.mock.calls[0][1]).toMatchObject({ runAsync: true });
        expect(daytona.process.getSessionCommandLogs.mock.calls[0].slice(0, 2)).toEqual([expect.any(String), "cmd-9"]);
        expect(onStdout.mock.calls).toEqual([["a"], ["c"]]);
        expect(onStderr.mock.calls).toEqual([["b"]]);
        expect(daytona.process.deleteSession).toHaveBeenCalled();
      });

      it("times a streamed command out at timeoutMs", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.getSessionCommandLogs.mockReturnValue(new Promise(() => {}));

        await expect(sandbox.run("sleep 99", { timeoutMs: 10, onStdout: () => {} })).rejects.toBeInstanceOf(SandboxTimeoutError);
        expect(daytona.process.deleteSession).toHaveBeenCalled();
      });
    });

    it("starts a command in a session it keeps, and returns the pid from the pid file", async () => {
      const { daytona, sandbox } = await connect();
      daytona.fs.downloadFile
        .mockRejectedValueOnce(new mocks.errors.DaytonaFileNotFoundError("not yet"))
        .mockResolvedValueOnce(Buffer.from("42\n"));
      const onStdout = vi.fn();

      expect(await sandbox.start("npm run dev", { cwd: "/app", envs: { A: "1" }, onStdout })).toEqual({ pid: 42 });
      const [sessionId, request, timeout] = daytona.process.executeSessionCommand.mock.calls[0];
      expect(sessionId).toMatch(/^cn-start-/);
      expect(request).toMatchObject({ runAsync: true });
      expect(request.command).toContain("echo $$ > /tmp/.codenaya/");
      expect(timeout).toBeUndefined();
      expect(daytona.fs.downloadFile.mock.calls[0][0]).toMatch(/^\/tmp\/\.codenaya\/.+\.pid$/);
      expect(daytona.process.getSessionCommandLogs).toHaveBeenCalledWith(sessionId, "cmd-1", onStdout, expect.any(Function));
      expect(daytona.process.deleteSession).not.toHaveBeenCalled();
    });

    it("records the pid of the started command itself", async () => {
      const { daytona, sandbox } = await connect();
      daytona.fs.downloadFile.mockResolvedValue(Buffer.from("1"));
      await sandbox.start("sleep 1");

      // The pid file holds the shell that then execs the command, so the pid is the command's.
      const { command } = daytona.process.executeSessionCommand.mock.calls[0][1];
      const dir = mkdtempSync(join(tmpdir(), "pid-"));
      try {
        const script = command.replaceAll("/tmp/.codenaya", dir).replace("sleep 1", () => "echo $$");
        const { stdout } = spawnSync("bash", ["-c", script], { encoding: "utf8" });
        const pidFile = spawnSync("bash", ["-c", `cat ${dir}/*.pid`], { encoding: "utf8" }).stdout;
        expect(stdout.trim()).toBe(pidFile.trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails a start whose pid never appears", async () => {
      const { daytona, sandbox } = await connect();
      daytona.fs.downloadFile.mockRejectedValue(new mocks.errors.DaytonaFileNotFoundError("missing"));
      vi.useFakeTimers();
      try {
        const rejection = expect(sandbox.start("false")).rejects.toThrow("Daytona did not report the started command's pid");
        // The poll's whole 2 s budget, without waiting for it.
        await vi.advanceTimersByTimeAsync(2_000);
        await rejection;
        expect(daytona.fs.downloadFile).toHaveBeenCalledTimes(20);
      } finally {
        vi.useRealTimers();
      }
    });

    it("writes files in one upload of Buffers after one mkdir of their unique parents", async () => {
      const { daytona, sandbox } = await connect();
      const bytes = new Uint8Array([0, 255, 10]);

      await sandbox.writeFiles([
        { path: "/app/a.ts", data: "a" },
        { path: "/app/b/c.ts", data: "/etc/passwd" },
        { path: "/app/b/d.bin", data: bytes.buffer },
      ]);

      expect(daytona.process.executeSessionCommand).toHaveBeenCalledTimes(1);
      const { command } = daytona.process.executeSessionCommand.mock.calls[0][1];
      expect(command).toContain("mkdir -p --");
      expect(command.split("/app/b").length - 1).toBe(1);
      expect(daytona.fs.uploadFiles).toHaveBeenCalledTimes(1);
      const [uploads] = daytona.fs.uploadFiles.mock.calls[0];
      // A string source would be read as a local file path.
      expect(uploads.every(({ source }) => Buffer.isBuffer(source))).toBe(true);
      expect(uploads.map(({ source, destination }) => [destination, String(source)]).slice(0, 2)).toEqual([
        ["/app/a.ts", "a"],
        ["/app/b/c.ts", "/etc/passwd"],
      ]);
      expect(new Uint8Array(uploads[2].source)).toEqual(bytes);
    });

    it("skips an empty write and fails when the parents can't be made", async () => {
      const { daytona, sandbox } = await connect();

      await sandbox.writeFiles([]);
      expect(daytona.process.createSession).not.toHaveBeenCalled();
      expect(daytona.fs.uploadFiles).not.toHaveBeenCalled();

      daytona.process.executeSessionCommand.mockResolvedValue({ cmdId: "cmd-1", exitCode: 1, stdout: "", stderr: "denied" });
      await expect(sandbox.writeFiles([{ path: "/root/x", data: "x" }])).rejects.toBeInstanceOf(SandboxExitError);
      expect(daytona.fs.uploadFiles).not.toHaveBeenCalled();
    });

    it("reads text and bytes", async () => {
      const { daytona, sandbox } = await connect();
      daytona.fs.downloadFile.mockResolvedValue(Buffer.from("héllo"));

      expect(await sandbox.readFile("/app/a.txt", "text")).toBe("héllo");
      expect(await sandbox.readFile("/app/a.txt", "bytes", { requestTimeoutMs: 2_000 })).toEqual(new Uint8Array(Buffer.from("héllo")));
      expect(daytona.fs.downloadFile).toHaveBeenLastCalledWith("/app/a.txt", 2);
    });
  });
});
