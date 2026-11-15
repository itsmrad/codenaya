import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AuthenticationError extends Error {}
  class SandboxError extends Error {}
  class RateLimitError extends SandboxError {}
  class TimeoutError extends SandboxError {}
  class CommandExitError extends SandboxError {
    constructor(
      readonly exitCode: number,
      readonly stdout: string,
      readonly stderr: string,
    ) {
      super(`exit status ${exitCode}`);
    }
  }
  return {
    errors: { AuthenticationError, RateLimitError, TimeoutError, CommandExitError },
    create: vi.fn(),
    connect: vi.fn(),
    list: vi.fn(),
    kill: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
  };
});

vi.mock("e2b", () => ({
  ...mocks.errors,
  Sandbox: {
    create: mocks.create,
    connect: mocks.connect,
    list: mocks.list,
    kill: mocks.kill,
    createSnapshot: mocks.createSnapshot,
    deleteSnapshot: mocks.deleteSnapshot,
  },
}));

import { createE2bProvider } from "./e2b";
import { SandboxConfigError, SandboxRateLimitError, SandboxTimeoutError } from "./types";

const fakeE2bSandbox = () => ({
  sandboxId: "sbx1",
  commands: { run: vi.fn(), list: vi.fn(), kill: vi.fn() },
  files: { write: vi.fn(), read: vi.fn() },
  getHost: vi.fn((port: number) => `${port}-sbx1.e2b.app`),
  getInfo: vi.fn(),
  kill: vi.fn(),
});

const provider = createE2bProvider("key_1");

describe("E2B provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.E2B_TEMPLATE;
  });

  it("creates from E2B_TEMPLATE with the key, metadata, timeouts and the localhost Host header", async () => {
    process.env.E2B_TEMPLATE = " codenaya-node22 ";
    mocks.create.mockResolvedValue(fakeE2bSandbox());

    const sandbox = await provider.create({
      timeoutMs: 60_000,
      requestTimeoutMs: 5_000,
      metadata: { userId: "u1", projectId: "p1" },
      localHostHeader: true,
    });

    expect(mocks.create).toHaveBeenCalledWith("codenaya-node22", {
      apiKey: "key_1",
      timeoutMs: 60_000,
      requestTimeoutMs: 5_000,
      metadata: { userId: "u1", projectId: "p1" },
      network: { maskRequestHost: "localhost:${PORT}" },
    });
    expect(sandbox).toMatchObject({ provider: "e2b", id: "sbx1" });
  });

  it("creates from the base template without a masked host by default", async () => {
    mocks.create.mockResolvedValue(fakeE2bSandbox());

    await provider.create({ timeoutMs: 1, metadata: { messageId: "m1" } });

    expect(mocks.create).toHaveBeenCalledWith("base", expect.not.objectContaining({ network: expect.anything() }));
  });

  it("lists one page of running sandboxes by metadata", async () => {
    const endAt = new Date("2026-11-15T12:00:00Z");
    const nextItems = vi.fn().mockResolvedValue([{ sandboxId: "sbx1", metadata: { userId: "u1" }, endAt, state: "running" }]);
    mocks.list.mockReturnValue({ nextItems });

    const listed = await provider.list({ metadata: { userId: "u1" }, limit: 3 });

    expect(mocks.list).toHaveBeenCalledWith({
      apiKey: "key_1",
      requestTimeoutMs: undefined,
      limit: 3,
      query: { metadata: { userId: "u1" }, state: ["running"] },
    });
    expect(listed).toEqual([{ id: "sbx1", metadata: { userId: "u1" }, endAt }]);
  });

  it("connects and kills with the key", async () => {
    mocks.connect.mockResolvedValue(fakeE2bSandbox());
    mocks.kill.mockResolvedValue(false);

    expect((await provider.connect("sbx1", { timeoutMs: 10 })).id).toBe("sbx1");
    expect(mocks.connect).toHaveBeenCalledWith("sbx1", { timeoutMs: 10, apiKey: "key_1" });
    expect(await provider.kill("sbx1")).toBe(false);
    expect(mocks.kill).toHaveBeenCalledWith("sbx1", { apiKey: "key_1" });
  });

  it.each([
    [new mocks.errors.AuthenticationError("bad key"), SandboxConfigError],
    [new mocks.errors.RateLimitError("slow down"), SandboxRateLimitError],
    [new mocks.errors.TimeoutError("sandbox timeout"), SandboxTimeoutError],
  ])("maps %o to the seam's error", async (error, Expected) => {
    mocks.create.mockRejectedValue(error);

    const rejection = provider.create({ timeoutMs: 1, metadata: {} });

    await expect(rejection).rejects.toBeInstanceOf(Expected);
    await expect(rejection).rejects.toMatchObject({ message: error.message, cause: error });
  });

  it("passes other errors through", async () => {
    const error = new Error("boom");
    mocks.kill.mockRejectedValue(error);

    await expect(provider.kill("sbx1")).rejects.toBe(error);
  });

  describe("sandbox", () => {
    const connect = async () => {
      const e2b = fakeE2bSandbox();
      mocks.connect.mockResolvedValue(e2b);
      return { e2b, sandbox: await provider.connect("sbx1") };
    };

    it("resolves a non-zero exit with its code and output", async () => {
      const { e2b, sandbox } = await connect();
      e2b.commands.run.mockRejectedValue(new mocks.errors.CommandExitError(2, "out", "err"));

      expect(await sandbox.run("npm install", { cwd: "/app" })).toEqual({ exitCode: 2, stdout: "out", stderr: "err" });
      expect(e2b.commands.run).toHaveBeenCalledWith("npm install", { cwd: "/app" });
    });

    it("maps a command timeout", async () => {
      const { e2b, sandbox } = await connect();
      e2b.commands.run.mockRejectedValue(new mocks.errors.TimeoutError("deadline exceeded"));

      await expect(sandbox.run("sleep 99", { timeoutMs: 1 })).rejects.toBeInstanceOf(SandboxTimeoutError);
    });

    it("starts a command in the background with no time limit", async () => {
      const { e2b, sandbox } = await connect();
      e2b.commands.run.mockResolvedValue({ pid: 42 });

      expect(await sandbox.start("npm run dev", { envs: { A: "1" } })).toEqual({ pid: 42 });
      expect(e2b.commands.run).toHaveBeenCalledWith("npm run dev", { envs: { A: "1" }, background: true, timeoutMs: 0 });
    });

    it("lists and kills envd's commands, and leaves out absent options as a direct call does", async () => {
      const { e2b, sandbox } = await connect();
      const command = { pid: 7, cmd: "/bin/bash", args: ["-l", "-c", "npm run dev"], envs: { A: "1" }, cwd: "/app" };
      e2b.commands.list.mockResolvedValue([command]);
      e2b.commands.kill.mockResolvedValue(true);
      e2b.commands.run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      expect(await sandbox.listCommands!()).toEqual([command]);
      expect(e2b.commands.list).toHaveBeenCalledWith();
      await sandbox.listCommands!({ requestTimeoutMs: 5 });
      expect(e2b.commands.list).toHaveBeenLastCalledWith({ requestTimeoutMs: 5 });
      expect(await sandbox.killCommand!(7, { requestTimeoutMs: 5 })).toBe(true);
      expect(e2b.commands.kill).toHaveBeenCalledWith(7, { requestTimeoutMs: 5 });
      await sandbox.run("true");
      expect(e2b.commands.run).toHaveBeenCalledWith("true");
    });

    it("writes files in one batch and skips an empty one", async () => {
      const { e2b, sandbox } = await connect();
      const files = [{ path: "/app/a.ts", data: "a" }, { path: "/app/b/c.ts", data: "c" }];

      await sandbox.writeFiles(files);
      await sandbox.writeFiles([]);

      expect(e2b.files.write).toHaveBeenCalledTimes(1);
      expect(e2b.files.write).toHaveBeenCalledWith(files);
    });

    it("reads text and bytes, builds the preview URL and returns info", async () => {
      const { e2b, sandbox } = await connect();
      const endAt = new Date();
      e2b.files.read.mockResolvedValue("x");
      e2b.getInfo.mockResolvedValue({ metadata: { userId: "u1" }, endAt, templateId: "t" });

      await sandbox.readFile("/a", "bytes");
      expect(e2b.files.read).toHaveBeenCalledWith("/a", { format: "bytes" });
      await sandbox.readFile("/a", "text");
      expect(e2b.files.read).toHaveBeenLastCalledWith("/a", { format: "text" });
      expect(await sandbox.previewUrl(4000)).toBe("https://4000-sbx1.e2b.app");
      expect(await sandbox.info()).toEqual({ metadata: { userId: "u1" }, endAt });
    });

    it("snapshots by sandbox id and creates from and deletes the snapshot", async () => {
      const { sandbox } = await connect();
      mocks.createSnapshot.mockResolvedValue({ snapshotId: "snap:1" });
      mocks.create.mockResolvedValue(fakeE2bSandbox());
      mocks.deleteSnapshot.mockResolvedValue(true);

      expect(await provider.snapshot!(sandbox)).toBe("snap:1");
      expect(mocks.createSnapshot).toHaveBeenCalledWith("sbx1", { apiKey: "key_1" });
      await provider.createFromSnapshot!("snap:1", { timeoutMs: 1, metadata: { messageId: "m1" } });
      expect(mocks.create).toHaveBeenCalledWith("snap:1", expect.objectContaining({ apiKey: "key_1", metadata: { messageId: "m1" } }));
      expect(await provider.deleteSnapshot!("snap:1")).toBe(true);
    });
  });
});
