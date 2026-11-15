import type { Sandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEV_COMMAND_ENV,
  DEV_SERVER_ENVS,
  DevServerStartError,
  PROXY_TARGET_ENV,
  fallbackDevStart,
  findPreviewDevServer,
  installWithDevServerStopped,
  isPortOpen,
  killTreeCommand,
  proxyTargetPort,
  restartDevServerIfDown,
} from "./dev-server";

afterEach(() => {
  vi.useRealTimers();
});

const fakeSandbox = (processes: Array<{ pid: number; envs: Record<string, string>; cwd?: string; cmd?: string; args?: string[] }>) => {
  const run = vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const sandbox = {
    commands: { list: vi.fn(async () => processes.map((process) => ({ cmd: "/bin/bash", args: [], ...process }))), run },
  } as unknown as Sandbox;
  return { sandbox, run };
};

describe("isPortOpen", () => {
  it("accepts a TCP connection without requesting a lazily compiled page", async () => {
    const { sandbox, run } = fakeSandbox([]);
    run.mockResolvedValue({ stdout: "open\n" });
    await expect(isPortOpen(sandbox, 3000)).resolves.toBe(true);
    const [command, options] = run.mock.calls[0];
    expect(command).toContain('require("net").connect');
    expect(command).toContain("port:3000");
    expect(command).not.toContain("curl");
    expect(options).toEqual({ timeoutMs: 3000 });
  });

  it("rejects refused connections and timed-out probes", async () => {
    const { sandbox, run } = fakeSandbox([]);
    run.mockResolvedValue({ stdout: "" });
    await expect(isPortOpen(sandbox, 5173)).resolves.toBe(false);
    run.mockRejectedValue(new Error("probe timeout"));
    await expect(isPortOpen(sandbox, 5173)).resolves.toBe(false);
  });
});

describe("installWithDevServerStopped (#486)", () => {
  const dev = { pid: 12, envs: { [DEV_COMMAND_ENV]: "npm run dev -- --host", HOST: "0.0.0.0" }, cwd: "/home/user/app" };

  it("stops only the marked dev server, installs, then starts it once the same way", async () => {
    const { sandbox, run } = fakeSandbox([{ pid: 3, envs: {} }, dev]);
    const onStdout = vi.fn();
    const install = vi.fn(async () => {
      expect(run).toHaveBeenCalledTimes(1);
      return "installed";
    });

    await expect(installWithDevServerStopped(sandbox, install, { onStdout })).resolves.toBe("installed");

    expect(run.mock.calls).toEqual([
      [killTreeCommand(12)],
      ["npm run dev -- --host", { cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0, onStdout }],
    ]);
  });

  it("starts the dev server again after a failed install", async () => {
    const { sandbox, run } = fakeSandbox([dev]);

    await expect(
      installWithDevServerStopped(sandbox, async () => {
        throw new Error("npm install failed");
      }),
    ).rejects.toThrow("npm install failed");

    expect(run).toHaveBeenLastCalledWith("npm run dev -- --host", expect.objectContaining({ background: true }));
  });

  it("stops every marked dev server, e.g. one a resumed boot left, and starts exactly one", async () => {
    const stale = { ...dev, pid: 30 };
    const { sandbox, run } = fakeSandbox([stale, { pid: 3, envs: {} }, dev]);

    await installWithDevServerStopped(sandbox, async () => undefined);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      killTreeCommand(30),
      killTreeCommand(12),
      "npm run dev -- --host",
    ]);
  });

  it("only installs when no dev server is running and the caller has no fallback", async () => {
    const { sandbox, run } = fakeSandbox([{ pid: 3, envs: {} }]);

    await installWithDevServerStopped(sandbox, async () => undefined);

    expect(run).not.toHaveBeenCalled();
  });

  it("starts the boot's dev server after the install when none is running, so a lost start heals", async () => {
    const { sandbox, run } = fakeSandbox([{ pid: 3, envs: {} }]);
    const fallback = { command: "npm run dev -- --host", envs: dev.envs, cwd: "/home/user/app" };

    await installWithDevServerStopped(sandbox, async () => undefined, {}, fallback);

    expect(run.mock.calls).toEqual([
      ["npm run dev -- --host", { cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0 }],
    ]);
  });

  it("names only the given pid in the kill command", () => {
    expect(killTreeCommand(12)).toContain("$(tree 12)");
    expect(killTreeCommand(12)).not.toMatch(/pkill|killall/);
  });

  it("waits for the dev server's port after starting a missing one (#774)", async () => {
    vi.useFakeTimers();
    const { sandbox, run } = fakeSandbox([]);
    run.mockResolvedValueOnce({}).mockResolvedValueOnce({ stdout: "" }).mockResolvedValue({ stdout: "open\n" });
    const fallback = { command: "npm run dev", envs: dev.envs, readyPort: 3000 };
    let done = false;
    const install = installWithDevServerStopped(sandbox, async () => "installed", {}, fallback).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await install;
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2][0]).toContain("port:3000");
  });

  it("rejects instead of succeeding when the port stays closed after launch", async () => {
    vi.useFakeTimers();
    const { sandbox, run } = fakeSandbox([]);
    run.mockResolvedValue({ stdout: "" });
    const rejected = expect(installWithDevServerStopped(sandbox, async () => undefined, {}, {
      command: "npm run dev", envs: dev.envs, readyPort: 5173,
    })).rejects.toBeInstanceOf(DevServerStartError);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });

  it("does not start a second dev server when another instance started one during the install", async () => {
    const { sandbox, run } = fakeSandbox([]);
    vi.mocked(sandbox.commands.list).mockResolvedValueOnce([]).mockResolvedValue([{ ...dev, cmd: "/bin/bash", args: [] }] as never);
    await installWithDevServerStopped(sandbox, async () => undefined, {}, { command: "npm run dev", envs: dev.envs, readyPort: 5173 });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not expose process errors from a failed fallback start", async () => {
    const { sandbox, run } = fakeSandbox([]);
    run.mockRejectedValue(new Error("private project env"));
    await expect(installWithDevServerStopped(sandbox, async () => undefined, {}, {
      command: "npm run dev", envs: dev.envs,
    })).rejects.toThrow(new DevServerStartError().message);
  });
});

describe("fallbackDevStart (#774)", () => {
  it.each([
    [{ dependencies: { vite: "7" } }, undefined, "npm run dev -- --host 0.0.0.0", 5173],
    [{ dependencies: { next: "16" } }, undefined, "npm run dev -- -H 0.0.0.0", 3000],
    [{ scripts: { dev: "next dev" } }, "npm run dev -- --host 0.0.0.0", "npm run dev -- -H 0.0.0.0", 3000],
  ])("starts %j like the boot and waits on the framework's port", (pkg, devCommand, command, readyPort) => {
    const files = [{ path: "package.json", content: JSON.stringify(pkg) }];
    expect(fallbackDevStart(files, devCommand, "/home/user/app")).toEqual({
      command,
      cwd: "/home/user/app",
      envs: { ...DEV_SERVER_ENVS, [DEV_COMMAND_ENV]: command },
      readyPort,
    });
  });

  it("waits on the proxy's target port when known, e.g. a custom server.port", () => {
    const files = [{ path: "package.json", content: "{}" }];
    expect(fallbackDevStart(files, undefined, "/home/user/app", 5180).readyPort).toBe(5180);
  });
});

describe("proxyTargetPort (#774)", () => {
  it("reads the port the boot's proxy forwards to, or nothing", async () => {
    const read = vi.fn(async () => 'const TARGET_PORT = parseInt(process.env.TARGET_PORT || "5180", 10);');
    const sandbox = { files: { read } } as unknown as Sandbox;
    await expect(proxyTargetPort(sandbox)).resolves.toBe(5180);
    read.mockRejectedValue(new Error("not found"));
    await expect(proxyTargetPort(sandbox)).resolves.toBeUndefined();
  });
});

describe("restarting the preview's dev server after a check build", () => {
  const dev = { pid: 12, envs: { [DEV_COMMAND_ENV]: "npm run dev", HOSTNAME: "0.0.0.0" }, cwd: "/home/user/app" };
  const proxy = { pid: 5, envs: { [PROXY_TARGET_ENV]: "3000" } };
  const preview = { port: 3000, start: { command: "npm run dev", envs: dev.envs, cwd: "/home/user/app" } };

  it("finds the dev server's port from the proxy and how to start it from the dev process", async () => {
    const { sandbox } = fakeSandbox([proxy, { pid: 3, envs: {} }, dev]);
    await expect(findPreviewDevServer(sandbox)).resolves.toEqual(preview);
  });

  it("finds none without a marked proxy or dev server, e.g. a sandbox booted before the proxy was marked", async () => {
    await expect(findPreviewDevServer(fakeSandbox([dev]).sandbox)).resolves.toBeNull();
    await expect(findPreviewDevServer(fakeSandbox([proxy]).sandbox)).resolves.toBeNull();
  });

  const bounds = { timeoutMs: 10_000, requestTimeoutMs: 10_000 };
  const probes = (run: ReturnType<typeof fakeSandbox>["run"]) =>
    run.mock.calls.filter(([command]) => String(command).includes('require("net")')).length;

  it("leaves a dev server whose port answers alone", async () => {
    const { sandbox, run } = fakeSandbox([proxy, dev]);
    run.mockResolvedValue({ stdout: "open\n" });

    await expect(restartDevServerIfDown(sandbox, preview, 10_000)).resolves.toBe(false);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("port:3000");
  });

  it("probes again before calling a slow port down", async () => {
    const { sandbox, run } = fakeSandbox([proxy, dev]);
    run.mockResolvedValueOnce({ stdout: "" }).mockResolvedValueOnce({ stdout: "open\n" });

    await expect(restartDevServerIfDown(sandbox, preview, 10_000)).resolves.toBe(false);

    expect(probes(run)).toBe(2);
    expect(run).not.toHaveBeenCalledWith(killTreeCommand(12), expect.anything());
  });

  it("stops what is left of a dead dev server, e.g. a `next dev` parent whose server was OOM-killed, and starts it the same way, bounded", async () => {
    const { sandbox, run } = fakeSandbox([proxy, dev]);

    await expect(restartDevServerIfDown(sandbox, preview, 10_000)).resolves.toBe(true);

    expect(probes(run)).toBe(3);
    expect(sandbox.commands.list).toHaveBeenCalledWith({ requestTimeoutMs: 10_000 });
    expect(run.mock.calls.slice(3)).toEqual([
      [killTreeCommand(12), bounds],
      ["npm run dev", { cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0, requestTimeoutMs: 10_000 }],
    ]);
  });

  it("leaves the dev server to an install that has it stopped (#486), so only one starts", async () => {
    const install = { pid: 40, envs: {}, cmd: "/bin/bash", args: ["-l", "-c", "npm install --prefer-offline"] };
    const { sandbox, run } = fakeSandbox([proxy, install]);

    await expect(restartDevServerIfDown(sandbox, preview, 10_000)).resolves.toBe(false);

    expect(run.mock.calls.slice(3)).toEqual([]);
  });

  it("starts it even when no dev process is left to stop", async () => {
    const { sandbox, run } = fakeSandbox([proxy]);

    await expect(restartDevServerIfDown(sandbox, preview, 10_000)).resolves.toBe(true);

    expect(run).toHaveBeenLastCalledWith("npm run dev", expect.objectContaining({ background: true, envs: dev.envs }));
  });
});
