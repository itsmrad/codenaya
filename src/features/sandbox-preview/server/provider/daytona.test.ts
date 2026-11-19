import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  SandboxConfigError, SandboxExitError, SandboxNotFoundError, SandboxRateLimitError, SandboxTimeoutError,
} from "./types";

const AUTO_DESTROY_AT = "2099-01-01T00:00:00.000Z";

type Request = { command: string; runAsync?: boolean };
type ExecResult = { cmdId: string; exitCode?: number; stdout?: string; stderr?: string };
type OnChunk = (chunk: string) => void;
type Logs = { output: string; stdout: string; stderr: string };

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
    // With callbacks it follows the stream; without, it returns the full logs.
    getSessionCommandLogs: vi.fn<(sessionId: string, cmdId: string, onStdout?: OnChunk, onStderr?: OnChunk) => Promise<Logs | undefined>>(
      async (_sessionId, _cmdId, onStdout) => (onStdout ? undefined : { output: "", stdout: "", stderr: "" }),
    ),
    deleteSession: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
    executeCommand: vi.fn<(command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => Promise<{ exitCode: number; result: string }>>(
      async () => ({ exitCode: 0, result: "" }),
    ),
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

    describe("run", () => {
      it("sets cwd and envs, quotes and odd names included, as bash reads them back", async () => {
        const { daytona, sandbox } = await connect();
        const cwd = mkdtempSync(join(tmpdir(), "it's "));
        try {
          await sandbox.run(`printf '%s|%s|%s' "$PWD" "$A" "$(env | grep '^X%%=')"`, {
            cwd,
            envs: { A: "x'y $HOME", "X%%": "1" },
            // No limit, so no GNU `timeout` is needed where the test runs; the wrapper is asserted below.
            timeoutMs: 0,
          });

          const { command } = daytona.process.executeSessionCommand.mock.calls[0][1];
          expect(spawnSync("bash", ["-c", command], { encoding: "utf8" }).stdout).toBe(`${cwd}|x'y $HOME|X%%=1__codenaya_run_end__`);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });

      it("returns output byte-exact, without the newline Daytona's session logs add", async () => {
        const { daytona, sandbox } = await connect();
        // The command as bash runs it, plus the newline Daytona ends unterminated output with.
        daytona.process.executeSessionCommand.mockImplementation(async (_sessionId, { command }) => {
          const ran = spawnSync("bash", ["-c", command], { encoding: "utf8" });
          return { cmdId: "cmd-1", exitCode: ran.status ?? -1, stdout: `${ran.stdout}\n`, stderr: `${ran.stderr}\n` };
        });

        // No limit, so no GNU `timeout` is needed where the test runs.
        expect(await sandbox.run("printf x", { timeoutMs: 0 })).toEqual({ exitCode: 0, stdout: "x", stderr: "" });
        expect(await sandbox.run("printf 'x\\n'; printf e >&2; exit 3", { timeoutMs: 0 })).toEqual({ exitCode: 3, stdout: "x\n", stderr: "e" });
      });

      it("resolves a non-zero exit with separate stdout and stderr, in its own session", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockResolvedValue({ cmdId: "cmd-1", exitCode: 2, stdout: "out", stderr: "err" });

        expect(await sandbox.run("npm install")).toEqual({ exitCode: 2, stdout: "out", stderr: "err" });
        const [sessionId, request, timeout] = daytona.process.executeSessionCommand.mock.calls[0];
        expect(daytona.process.createSession).toHaveBeenCalledWith(sessionId);
        // E2B's default command timeout, enforced in the sandbox; the HTTP wait outlasts it.
        expect(request).toEqual({ command: expect.stringContaining("timeout -k 5 60s bash -c") });
        expect(request.command).toContain("npm install");
        expect(timeout).toBe(70);
        expect(daytona.process.deleteSession).toHaveBeenCalledWith(sessionId);
      });

      it("stops the command in the sandbox at timeoutMs, and 0 means no limit", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockRejectedValue(new mocks.errors.DaytonaConnectionTimeoutError("timeout of 12000ms exceeded"));

        await expect(sandbox.run("sleep 99", { timeoutMs: 1_500 })).rejects.toBeInstanceOf(SandboxTimeoutError);
        const [, request, timeout] = daytona.process.executeSessionCommand.mock.calls[0];
        expect(request.command).toContain("timeout -k 5 2s");
        expect(timeout).toBe(12);
        expect(daytona.process.deleteSession).toHaveBeenCalled();

        await sandbox.run("true", { timeoutMs: 0 }).catch(() => {});
        const [, unlimited, wait] = daytona.process.executeSessionCommand.mock.calls[1];
        expect(unlimited.command).not.toContain("timeout -k");
        // Still explicit: the client's 30 s default would cut it short.
        expect(wait).toBe(3_610);
      });

      it("reads timeout's exit after the deadline as a timeout, and an early 124 as a result", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { cmdId: "cmd-1", exitCode: 124, stdout: "", stderr: "" };
        });

        await expect(sandbox.run("npm run build", { timeoutMs: 1 })).rejects.toBeInstanceOf(SandboxTimeoutError);
        expect(await sandbox.run("exit 124")).toMatchObject({ exitCode: 124 });
      });

      it("streams output to the callbacks and resolves with the full logs and the exit code", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockResolvedValue({ cmdId: "cmd-9" });
        daytona.process.getSessionCommandLogs.mockImplementation(async (_sessionId, _cmdId, onStdout, onStderr) => {
          if (!onStdout || !onStderr) return { output: "", stdout: "full-out", stderr: "full-err" };
          onStdout("a");
          onStderr("b");
          onStdout("c");
        });
        daytona.process.getSessionCommand.mockResolvedValue({ id: "cmd-9", exitCode: 3 });
        const onStdout = vi.fn();
        const onStderr = vi.fn();

        expect(await sandbox.run("npm run build", { onStdout, onStderr })).toEqual({ exitCode: 3, stdout: "full-out", stderr: "full-err" });
        expect(daytona.process.executeSessionCommand.mock.calls[0][1]).toMatchObject({ runAsync: true });
        expect(daytona.process.getSessionCommandLogs.mock.calls[0].slice(0, 2)).toEqual([expect.any(String), "cmd-9"]);
        expect(onStdout.mock.calls).toEqual([["a"], ["c"]]);
        expect(onStderr.mock.calls).toEqual([["b"]]);
        expect(daytona.process.deleteSession).toHaveBeenCalled();
      });

      it("streams up to the end marker, even split across chunks, and drops what follows it", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.getSessionCommandLogs.mockImplementation(async (_sessionId, _cmdId, onStdout, onStderr) => {
          if (!onStdout || !onStderr) return { output: "", stdout: "x__y\n__codenaya_run_end__\n", stderr: "e__codenaya_run_end__\n" };
          for (const chunk of ["x_", "_y\n__", "codenaya_", "run_end__", "\n"]) onStdout(chunk);
          for (const chunk of ["e__cod", "enaya_run_", "end__\n"]) onStderr(chunk);
        });
        let streamed = "";
        let streamedErr = "";

        const result = await sandbox.run("printf 'x__y\\n'", {
          onStdout: (chunk) => { streamed += chunk; },
          onStderr: (chunk) => { streamedErr += chunk; },
        });

        expect(result).toEqual({ exitCode: 0, stdout: "x__y\n", stderr: "e" });
        expect(streamed).toBe("x__y\n");
        expect(streamedErr).toBe("e");
      });

      it("releases a held tail when the stream ends without the marker", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.getSessionCommandLogs.mockImplementation(async (_sessionId, _cmdId, onStdout) => {
          if (!onStdout) throw new Error("logs unavailable");
          // The stream drops after output that ends like the marker's start.
          onStdout("a__cod");
          return undefined;
        });
        let streamed = "";

        const result = await sandbox.run("npm run build", { onStdout: (chunk) => { streamed += chunk; } });

        expect(streamed).toBe("a__cod");
        expect(result.stdout).toBe("a__cod");
      });

      it("waits out a dropped stream for the exit code, and falls back to the streamed output", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.getSessionCommandLogs.mockImplementation(async (_sessionId, _cmdId, onStdout) => {
          if (!onStdout) throw new Error("logs unavailable");
          onStdout("partial");
          return undefined;
        });
        daytona.process.getSessionCommand.mockResolvedValueOnce({ id: "cmd-1" }).mockResolvedValue({ id: "cmd-1", exitCode: 0 });

        expect(await sandbox.run("npm run build", { onStdout: () => {} })).toEqual({ exitCode: 0, stdout: "partial", stderr: "" });
        expect(daytona.process.getSessionCommand).toHaveBeenCalledTimes(2);
      });

      it("kills the command's process group after a failed wait, and not after a finished one", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockRejectedValueOnce(new Error("socket hang up"));

        await expect(sandbox.run("sleep 99")).rejects.toThrow("socket hang up");
        const [sessionId, { command }] = daytona.process.executeSessionCommand.mock.calls[0];
        const pidFile = `/tmp/.codenaya/${sessionId}.pid`;
        // The wrapper records the pid `timeout` runs as, which leads its own process group.
        expect(command).toContain(`(echo $BASHPID > ${pidFile} && exec env -- timeout -k 5 60s bash -c`);
        const [kill, , , timeout] = daytona.process.executeCommand.mock.calls[0];
        expect(kill).toContain(pidFile);
        expect(kill).toContain("kill -TERM -- -$p");
        expect(timeout).toBe(15);
        expect(daytona.process.deleteSession).toHaveBeenCalledWith(sessionId);

        await sandbox.run("true");
        expect(daytona.process.executeCommand).toHaveBeenCalledTimes(1);
      });

      it("never blocks on or fails from the group kill", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.getSessionCommandLogs.mockRejectedValue(new Error("stream dropped"));
        daytona.process.executeCommand.mockReturnValueOnce(new Promise(() => {}));

        await expect(sandbox.run("sleep 99", { onStdout: () => {} })).rejects.toThrow("stream dropped");
        daytona.process.executeCommand.mockRejectedValueOnce(new Error("sandbox gone"));
        await expect(sandbox.run("sleep 99", { onStdout: () => {} })).rejects.toThrow("stream dropped");
        expect(daytona.process.executeCommand).toHaveBeenCalledTimes(2);
      });

      it("kills the group TERM then KILL, and never pid 1 or a missing pid", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.executeSessionCommand.mockRejectedValue(new Error("socket hang up"));
        await sandbox.run("sleep 99").catch(() => {});
        const [sessionId] = daytona.process.executeSessionCommand.mock.calls[0];
        const pidFile = `/tmp/.codenaya/${sessionId}.pid`;
        const [kill] = daytona.process.executeCommand.mock.calls[0];
        // The kill script as bash runs it, with kill and sleep stubbed to print.
        const runKill = (pid?: string) => {
          mkdirSync("/tmp/.codenaya", { recursive: true });
          if (pid !== undefined) writeFileSync(pidFile, `${pid}\n`);
          const stub = `kill() { echo "kill $*"; }; sleep() { echo "sleep $*"; }; export -f kill sleep; ${kill}`;
          const out = spawnSync("bash", ["-c", stub], { encoding: "utf8" }).stdout.split("\n").filter((line) => !line.startsWith("sleep 0.1"));
          expect(existsSync(pidFile)).toBe(false);
          return out.filter(Boolean);
        };

        expect(runKill("4242")).toEqual(["kill -TERM -- -4242", "sleep 2", "kill -KILL -- -4242"]);
        expect(runKill("1")).toEqual([]);
        expect(runKill("-1")).toEqual([]);
        expect(runKill("")).toEqual([]);
        expect(runKill()).toEqual([]);
      });

      it("times a streamed command out after its wait", async () => {
        const { daytona, sandbox } = await connect();
        daytona.process.getSessionCommandLogs.mockReturnValue(new Promise(() => {}));
        vi.useFakeTimers();
        try {
          const rejection = expect(sandbox.run("sleep 99", { timeoutMs: 10, onStdout: () => {} })).rejects.toBeInstanceOf(SandboxTimeoutError);
          await vi.advanceTimersByTimeAsync(10_100);
          await rejection;
          expect(daytona.process.deleteSession).toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
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
      // No time limit on a started command.
      expect(request.command).not.toContain("timeout -k");
      expect(timeout).toBeUndefined();
      expect(daytona.fs.downloadFile.mock.calls[0]).toEqual([expect.stringMatching(/^\/tmp\/\.codenaya\/.+\.pid$/), 5]);
      expect(daytona.process.getSessionCommandLogs).toHaveBeenCalledWith(sessionId, "cmd-1", onStdout, expect.any(Function));
      expect(daytona.process.deleteSession).not.toHaveBeenCalled();
    });

    it("fails a start whose pid never appears", async () => {
      const { daytona, sandbox } = await connect();
      daytona.fs.downloadFile.mockRejectedValue(new mocks.errors.DaytonaFileNotFoundError("missing"));
      vi.useFakeTimers();
      try {
        const rejection = expect(sandbox.start("false")).rejects.toThrow("Daytona did not report the started command's pid");
        // The poll's whole 5 s budget, without waiting for it.
        await vi.advanceTimersByTimeAsync(5_100);
        await rejection;
        expect(daytona.process.deleteSession).toHaveBeenCalled();
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

      expect(daytona.process.executeSessionCommand).toHaveBeenCalledTimes(2);
      const { command } = daytona.process.executeSessionCommand.mock.calls[0][1];
      expect(command).toContain("mkdir -p --");
      expect(command.split("/app/b").length - 1).toBe(1);
      expect(daytona.fs.uploadFiles).toHaveBeenCalledTimes(1);
      const [uploads, timeout] = daytona.fs.uploadFiles.mock.calls[0];
      // The SDK's own default is 30 min.
      expect(timeout).toBe(120);
      // The checksum manifest rides in the same batch and is checked after it.
      const manifest = uploads[3];
      expect(manifest.destination).toMatch(/^\/tmp\/\.codenaya\/upload-.+\.sha256$/);
      expect(String(manifest.source)).toBe(
        `${createHash("sha256").update("a").digest("hex")}  /app/a.ts\n` +
          `${createHash("sha256").update("/etc/passwd").digest("hex")}  /app/b/c.ts\n` +
          `${createHash("sha256").update(bytes).digest("hex")}  /app/b/d.bin\n`,
      );
      expect(daytona.process.executeSessionCommand.mock.calls[1][1].command).toContain("sha256sum --check --quiet");
      // A string source would be read as a local file path.
      expect(uploads.every(({ source }) => Buffer.isBuffer(source))).toBe(true);
      expect(uploads.map(({ source, destination }) => [destination, String(source)]).slice(0, 2)).toEqual([
        ["/app/a.ts", "a"],
        ["/app/b/c.ts", "/etc/passwd"],
      ]);
      expect(new Uint8Array(uploads[2].source)).toEqual(bytes);
    });

    it("fails a write whose upload didn't land, as the serverless SDK path won't say", async () => {
      const { daytona, sandbox } = await connect();
      daytona.process.executeSessionCommand
        .mockResolvedValueOnce({ cmdId: "cmd-1", exitCode: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ cmdId: "cmd-2", exitCode: 1, stdout: "/app/.env: FAILED", stderr: "" });

      await expect(sandbox.writeFiles([{ path: "/app/.env", data: "A=1" }])).rejects.toBeInstanceOf(SandboxExitError);
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
      // Bounded even without a budget: the SDK's own default is 30 min.
      expect(daytona.fs.downloadFile).toHaveBeenLastCalledWith("/app/a.txt", 30);
      expect(await sandbox.readFile("/app/a.txt", "bytes", { requestTimeoutMs: 2_000 })).toEqual(new Uint8Array(Buffer.from("héllo")));
      expect(daytona.fs.downloadFile).toHaveBeenLastCalledWith("/app/a.txt", 2);
    });
  });
});
