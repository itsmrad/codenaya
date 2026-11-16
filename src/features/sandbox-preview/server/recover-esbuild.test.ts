import type { Sandbox as E2bSandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromE2bSandbox } from "./provider/e2b";
import { BOOT_INSTALL_ENVS, DEV_COMMAND_ENV, DEV_START_COMMAND, READ_DEV_PGID_COMMAND, SHORT_CALL_MS, killDevServersCommand, killProjectNodesCommand } from "./dev-server";
import { recoverEsbuild } from "./recover-esbuild";
import { ESBUILD_RECOVERY_COOLDOWN_MS } from "../utils/esbuild-recovery";

const bounds = { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS };
const start = { background: true, timeoutMs: 0, requestTimeoutMs: SHORT_CALL_MS };
const dev = { pid: 12, cmd: "bash", args: ["-c", "npm run dev"], envs: { [DEV_COMMAND_ENV]: "npm run dev -- --host", HOST: "0.0.0.0" }, cwd: "/home/user/app" };
let sequence = 0;
const fakeSandbox = (processes: Array<{ pid: number; cmd: string; args: string[]; envs: Record<string, string>; cwd?: string }> = [dev]) => {
  const run = vi.fn<(...args: unknown[]) => Promise<{ exitCode: number; stdout: string }>>(async (command) => ({ exitCode: 0, stdout: command === "ls -1" ? "package.json\nvite.config.ts\n" : "" }));
  const list = vi.fn(async () => processes);
  const read = vi.fn(async () => JSON.stringify({ scripts: { dev: "vite" } }));
  const sandbox = fromE2bSandbox({ files: { read }, sandboxId: `recovery-${sequence++}`, commands: { list, run } } as unknown as E2bSandbox);
  return { sandbox, run, list, read };
};
afterEach(() => vi.useRealTimers());

describe("recoverEsbuild (#776)", () => {
  it("kills every marked dev server and starts one in its own group with the same command, env and cwd", async () => {
    const { sandbox, run } = fakeSandbox([dev, { ...dev, pid: 30 }, { ...dev, pid: 2, envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
    expect(run.mock.calls).toEqual([
      ["ls -1", { cwd: dev.cwd, ...bounds }],
      [READ_DEV_PGID_COMMAND, bounds],
      [killDevServersCommand([12, 30]), bounds],
      [killProjectNodesCommand(dev.cwd), bounds],
      [DEV_START_COMMAND, { cwd: dev.cwd, envs: dev.envs, ...start }],
    ]);
    expect(await recoverEsbuild(sandbox)).toBe("limited");
    expect(run).toHaveBeenCalledTimes(5);
  });

  it.each([
    [{ dependencies: { next: "16", vite: "8" } }, "npm run dev", "unavailable"],
    [{ scripts: { dev: "next dev" } }, "npm run dev", "unavailable"],
    [{}, "next dev -H 0.0.0.0", "unavailable"],
    [{ dependencies: { "@tanstack/react-start": "1" } }, "npm run dev", "restarted"],
  ])("gates recovery using the project framework: %j", async (pkg, command, status) => {
    const { sandbox, run, read } = fakeSandbox([{ ...dev, envs: { [DEV_COMMAND_ENV]: command } }]);
    read.mockResolvedValue(JSON.stringify(pkg));
    expect(await recoverEsbuild(sandbox)).toBe(status);
    expect(run.mock.calls.some(([cmd]) => cmd === DEV_START_COMMAND)).toBe(status === "restarted");
  });

  it("rejects a Next config even alongside a Vite config", async () => {
    const { sandbox, run } = fakeSandbox();
    run.mockResolvedValueOnce({ exitCode: 0, stdout: "package.json\nvite.config.ts\nnext.config.mjs\n" });
    expect(await recoverEsbuild(sandbox)).toBe("unavailable");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not restart an unknown framework or spend its attempt", async () => {
    const { sandbox, run } = fakeSandbox();
    run.mockResolvedValueOnce({ exitCode: 0, stdout: "package.json\n" });
    expect(await recoverEsbuild(sandbox)).toBe("unavailable");
    expect(run).toHaveBeenCalledTimes(1);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
  });

  it.each([
    ["npm", ["install"]], ["pnpm", ["i"]], ["yarn", ["add", "react"]],
    ["bun", ["install"]], ["npm", ["ci"]], ["bash", ["-c", "cd /home/user/app && npm install"]],
    ["npm", ["--prefix", "/home/user/app", "install"]],
    ["pnpm", ["--dir", "/home/user/app", "install"]], ["pnpm", ["-C", "app", "add", "x"]],
    ["yarn", ["--cwd", "app", "add", "x"]], ["pnpm", ["--filter", "app", "install"]],
    ["npm", ["-w", "app", "ci"]], ["npm", ["--workspace", "app", "install"]],
    ["npm", ["--silent", "--prefix=/home/user/app", "install"]],
    ["bash", ["-c", 'pnpm --filter app --dir "/home/user/my app" install']],
  ])("waits for %s %j", async (cmd, args) => {
    const { sandbox, run } = fakeSandbox([dev, { ...dev, cmd, args, envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("busy");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["npm", ["run", "build:ci"]], ["pnpm", ["run", "add-x"]],
    ["yarn", ["run", "add", "ci"]], ["bun", ["run", "build", "install"]],
    ["npm", ["run", "install-deps"]], ["npm", ["run", "build"]],
    ["npm", ["--prefix", "app", "run", "install-deps"]],
    ["pnpm", ["--filter", "app", "run", "build"]],
    ["npm", ["--prefix", "install", "run", "build"]],
  ])("does not mistake %s %j for an install", async (cmd, args) => {
    const { sandbox } = fakeSandbox([dev, { ...dev, cmd, args, envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
  });

  it("does nothing during an install and does not spend its attempt", async () => {
    const { sandbox, run, list } = fakeSandbox([dev, { ...dev, pid: 5, cmd: "npm", args: ["install"], envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("busy");
    expect(run).not.toHaveBeenCalled();
    list.mockResolvedValue([dev]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
  });

  it("treats a tagged custom install as busy too", async () => {
    const { sandbox, run } = fakeSandbox([dev, { pid: 6, cmd: "bash", args: ["-c", "bash setup.sh"], envs: BOOT_INSTALL_ENVS, cwd: dev.cwd }]);
    expect(await recoverEsbuild(sandbox)).toBe("busy");
    expect(run).not.toHaveBeenCalled();
  });

  it("reserves before listing commands so simultaneous errors cannot restart twice", async () => {
    const { sandbox, run, list } = fakeSandbox();
    let resolve!: (processes: typeof dev[]) => void;
    list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const first = recoverEsbuild(sandbox);
    expect(await recoverEsbuild(sandbox)).toBe("busy");
    resolve([dev]);
    expect(await first).toBe("restarted");
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("limits failed stop/start attempts too, and stops after three", async () => {
    vi.useFakeTimers();
    const { sandbox, run } = fakeSandbox();
    run.mockImplementation(async (command) => {
      if (command === "ls -1") return { exitCode: 0, stdout: "package.json\nvite.config.ts\n" };
      throw new Error("unreachable");
    });
    for (let i = 0; i < 3; i++) {
      await expect(recoverEsbuild(sandbox)).rejects.toThrow("unreachable");
      expect(await recoverEsbuild(sandbox)).toBe("limited");
      vi.advanceTimersByTime(ESBUILD_RECOVERY_COOLDOWN_MS);
    }
    expect(await recoverEsbuild(sandbox)).toBe("limited");
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("leaves a missing dev command to the install path (#774)", async () => {
    const { sandbox, run } = fakeSandbox([]);
    expect(await recoverEsbuild(sandbox)).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});
