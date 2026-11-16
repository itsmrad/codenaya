import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { Sandbox as E2bSandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fromE2bSandbox } from "./provider/e2b";

import {
  DEV_COMMAND_ENV,
  DEV_SERVER_ENVS,
  DevServerStartError,
  DEV_START_COMMAND,
  READ_DEV_PGID_COMMAND,
  SHORT_CALL_MS,
  PROXY_TARGET_ENV,
  fallbackDevStart,
  findPreviewDevServer,
  installWithDevServerStopped,
  isPortOpen,
  killTreeCommand,
  proxyTargetPort,
  killDevServersCommand,
  killProjectNodesCommand,
  restartDevServerIfDown,
  runDevServer,
} from "./dev-server";

afterEach(() => {
  vi.useRealTimers();
});
const bounds = { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS };

const fakeSandbox = (processes: Array<{ pid: number; envs: Record<string, string>; cwd?: string; cmd?: string; args?: string[] }>) => {
  const run = vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const list = vi.fn(async () => processes.map((process) => ({ cmd: "/bin/bash", args: [], ...process })));
  const sandbox = fromE2bSandbox({ commands: { list, run } } as unknown as E2bSandbox);
  return { sandbox, run, list };
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
      expect(run).toHaveBeenCalledTimes(3);
      return "installed";
    });

    await expect(installWithDevServerStopped(sandbox, install, { onStdout })).resolves.toBe("installed");

    expect(run.mock.calls).toEqual([
      [READ_DEV_PGID_COMMAND, bounds],
      [killTreeCommand(12), bounds],
      [killProjectNodesCommand(dev.cwd), bounds],
      [DEV_START_COMMAND, { cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0, requestTimeoutMs: SHORT_CALL_MS, onStdout }],
    ]);
  });

  it("starts the dev server again after a failed install", async () => {
    const { sandbox, run } = fakeSandbox([dev]);

    await expect(
      installWithDevServerStopped(sandbox, async () => {
        throw new Error("npm install failed");
      }),
    ).rejects.toThrow("npm install failed");

    expect(run).toHaveBeenLastCalledWith(DEV_START_COMMAND, expect.objectContaining({ background: true }));
  });

  it("stops every marked dev server, e.g. one a resumed boot left, and starts exactly one", async () => {
    const stale = { ...dev, pid: 30 };
    const { sandbox, run } = fakeSandbox([stale, { pid: 3, envs: {} }, dev]);

    await installWithDevServerStopped(sandbox, async () => undefined);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      READ_DEV_PGID_COMMAND,
      killDevServersCommand([30, 12]),
      killProjectNodesCommand(dev.cwd),
      DEV_START_COMMAND,
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
      [READ_DEV_PGID_COMMAND, bounds],
      [killProjectNodesCommand(dev.cwd), bounds],
      [DEV_START_COMMAND, { cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0, requestTimeoutMs: SHORT_CALL_MS }],
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
    const { sandbox, run, list } = fakeSandbox([]);
    list.mockResolvedValueOnce([]).mockResolvedValue([{ ...dev, cmd: "/bin/bash", args: [] }] as never);
    run.mockResolvedValue({ stdout: "open\n" });
    await installWithDevServerStopped(sandbox, async () => undefined, {}, { command: "npm run dev", envs: dev.envs, readyPort: 5173 });
    // No second start, but its readiness is still awaited.
    expect(run.mock.calls.map(([command]) => command)).toEqual([expect.stringContaining("port:5173")]);
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
    const sandbox = fromE2bSandbox({ files: { read } } as unknown as E2bSandbox);
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
    const { sandbox, run, list } = fakeSandbox([proxy, dev]);

    await expect(restartDevServerIfDown(sandbox, preview, 10_000)).resolves.toBe(true);

    expect(probes(run)).toBe(3);
    expect(list).toHaveBeenCalledWith({ requestTimeoutMs: 10_000 });
    expect(run.mock.calls.slice(3)).toEqual([
      [READ_DEV_PGID_COMMAND, bounds],
      [killTreeCommand(12), bounds],
      [killProjectNodesCommand(dev.cwd), bounds],
      [DEV_START_COMMAND, { cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0, requestTimeoutMs: 10_000 }],
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

    expect(run).toHaveBeenLastCalledWith(DEV_START_COMMAND, expect.objectContaining({ background: true, envs: dev.envs }));
  });
});

describe("dev server process groups", () => {
  it("records the actual session leader inside setsid, including when setsid forks", () => {
    expect(DEV_START_COMMAND).toContain("command -v setsid");
    expect(DEV_START_COMMAND).toContain("exec setsid --wait sh -c");
    expect(DEV_START_COMMAND).toContain('echo "$$" > /tmp/codenaya-dev-server.pgid');
    expect(DEV_START_COMMAND).toContain('exec bash -c "$CODENAYA_DEV_COMMAND"');
    // A user's devCommand may use bash syntax (`source`, `[[ ]]`, `&>`); node:22's sh is dash.
    expect(DEV_START_COMMAND).not.toMatch(/(^|[^a-z])sh -c "\$CODENAYA_DEV_COMMAND"/);
    expect(DEV_START_COMMAND).toContain("else rm -f /tmp/codenaya-dev-server.pgid;");
  });

  it("signals the recorded group even when its parent is no longer listed", () => {
    const command = killDevServersCommand([], 42);
    expect(command).toContain("kill -TERM -- -42 2>/dev/null; sleep 0.5; kill -KILL -- -42 2>/dev/null;");
    expect(command).not.toContain("tree");
  });

  const runShell = (command: string, environ: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "pgid-"));
    const log = join(dir, "log");
    if (environ !== null) writeFileSync(join(dir, "environ"), environ);
    const script = command.replaceAll("/proc/42/environ", join(dir, "environ"));
    execFileSync("sh", ["-c", `kill() { echo "kill $*" >> ${log}; }; sleep() { :; }; ${script}`]);
    return existsSync(log) ? readFileSync(log, "utf8") : "";
  };

  it("signals the group only while its leader still carries the dev marker", () => {
    const marked = runShell(killDevServersCommand([], 42), `PATH=/bin\0${DEV_COMMAND_ENV}=npm run dev\0`);
    expect(marked).toBe("kill -TERM -- -42\nkill -KILL -- -42\n");
  });

  it.each([["a reused pgid", "PATH=/bin\0npm_command=install\0"], ["an exited leader", null]])(
    "skips a stale group record for %s and falls back to the listed trees",
    (_, environ) => {
      expect(runShell(killDevServersCommand([], 42), environ)).toBe("");
      const command = killDevServersCommand([12], 42);
      expect(command).toContain(`else ${killTreeCommand(12)}; fi`);
      expect(runShell(command, environ)).not.toContain("-- -42");
    },
  );

  it.each([undefined, 0, 1, -42, NaN, 12.5, Infinity])("falls back to the listed trees for an unknown/invalid pgid %s", (pgid) => {
    expect(killDevServersCommand([12], pgid)).toBe(killTreeCommand(12));
    expect(killDevServersCommand([], pgid)).toBe("");
  });

  it("uses only Node and /proc to reap remaining project Node processes, excluding itself", () => {
    const command = killProjectNodesCommand("/home/user/app's code");
    expect(command).toContain('readdirSync("/proc")');
    expect(command).toContain('readlinkSync(`${base}/cwd`)');
    expect(command).toContain('readlinkSync(`${base}/exe`)');
    expect(command).toContain('readFileSync(`${base}/environ`');
    expect(command).toContain('pid !== process.pid');
    expect(command).toContain('process.kill(pid, "SIGKILL")');
    expect(command).toContain("'/home/user/app'\"'\"'s code'");
    expect(command).not.toMatch(/lsof|fuser|pkill|killall/);
  });

  it("reaps a marked orphan without killing an install, the proxy, a non-Node command, or the cleanup itself", () => {
    const kill = vi.fn();
    const cwd = "/home/user/app";
    const dev = `HOME=/home/user\0${DEV_COMMAND_ENV}=npm run dev\0`;
    const processes: Record<string, { cwd: string; exe: string; environ: string }> = {
      "12": { cwd, exe: "/usr/local/bin/node", environ: dev },
      "13": { cwd: "/home/user", exe: "/usr/local/bin/node", environ: dev },
      "14": { cwd, exe: "/bin/bash", environ: dev },
      "15": { cwd, exe: "/usr/local/bin/node", environ: dev },
      "17": { cwd, exe: "/usr/local/bin/node", environ: "HOME=/home/user\0npm_command=install\0" },
    };
    const fs = {
      readdirSync: () => ["self", "12", "13", "14", "15", "16", "17"],
      readFileSync: (path: string) => processes[path.split("/")[2]].environ,
      readlinkSync: (path: string) => {
        const [, , pid, field] = path.split("/");
        const entry = processes[pid];
        if (!entry) throw Object.assign(new Error("process exited"), { code: "ENOENT" });
        return field === "cwd" ? entry.cwd : entry.exe;
      },
    };
    const script = killProjectNodesCommand(cwd).match(/^node -e '([^']*)' /)?.[1];
    expect(script).toBeDefined();
    runInNewContext(script!, { require: () => fs, process: { argv: ["node", cwd], pid: 15, kill } });
    expect(kill.mock.calls).toEqual([[12, "SIGKILL"]]);
  });

  it.each([1000, 60_000])("bounds a background start's request without timing out the server (%s)", async (requestTimeoutMs) => {
    const { sandbox, run } = fakeSandbox([]);
    await runDevServer(sandbox, { command: "npm run dev", envs: {} }, { requestTimeoutMs });
    expect(run).toHaveBeenLastCalledWith(DEV_START_COMMAND, expect.objectContaining({
      timeoutMs: 0, requestTimeoutMs: Math.min(requestTimeoutMs, SHORT_CALL_MS),
    }));
  });

  it.each([true, false])("reinstall kills the persisted group when its parent is listed: %s", async (listed) => {
    const dev = { pid: 12, cwd: "/home/user/app", envs: { [DEV_COMMAND_ENV]: "npm run dev" } };
    const { sandbox, run } = fakeSandbox(listed ? [dev] : []);
    run.mockResolvedValueOnce({ exitCode: 0, stdout: "42\n" });
    const install = vi.fn(async () => {
      expect(run.mock.calls.slice(0, 3)).toEqual([
        [READ_DEV_PGID_COMMAND, bounds],
        [killDevServersCommand(listed ? [12] : [], 42), bounds],
        [killProjectNodesCommand(dev.cwd), bounds],
      ]);
    });
    await installWithDevServerStopped(sandbox, install, {}, { command: "npm run dev", envs: dev.envs, cwd: dev.cwd });
    expect(install).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith(DEV_START_COMMAND, expect.objectContaining({ requestTimeoutMs: SHORT_CALL_MS }));
  });

  it("restart kills a persisted group after the parent has disappeared from E2B", async () => {
    const { sandbox, run } = fakeSandbox([]);
    run.mockImplementation(async (command) => ({ exitCode: 0, stdout: command === READ_DEV_PGID_COMMAND ? "42\n" : "" }));
    await restartDevServerIfDown(sandbox, { port: 3000, start: { command: "npm run dev", envs: {}, cwd: "/home/user/app" } }, SHORT_CALL_MS);
    expect(run.mock.calls.slice(3, 6)).toEqual([
      [READ_DEV_PGID_COMMAND, bounds],
      [killDevServersCommand([], 42), bounds],
      [killProjectNodesCommand("/home/user/app"), bounds],
    ]);
    expect(run).toHaveBeenLastCalledWith(DEV_START_COMMAND, expect.objectContaining({ envs: { [DEV_COMMAND_ENV]: "npm run dev" } }));
  });
});
