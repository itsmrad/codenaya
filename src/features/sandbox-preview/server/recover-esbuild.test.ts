import type { Sandbox as E2bSandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromE2bSandbox } from "./provider/e2b";
import { DEV_COMMAND_ENV, DEV_START_COMMAND, READ_DEV_PGID_COMMAND, SHORT_CALL_MS, killDevServersCommand, killProjectNodesCommand } from "./dev-server";
import { recoverEsbuild } from "./recover-esbuild";
import { ESBUILD_RECOVERY_COOLDOWN_MS } from "../utils/esbuild-recovery";

const bounds = { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS };
const start = { background: true, timeoutMs: 0, requestTimeoutMs: SHORT_CALL_MS };
const dev = { pid: 12, cmd: "bash", args: ["-c", "npm run dev"], envs: { [DEV_COMMAND_ENV]: "npm run dev -- --host", HOST: "0.0.0.0" }, cwd: "/home/user/app" };
let sequence = 0;
const fakeSandbox = (processes: Array<{ pid: number; cmd: string; args: string[]; envs: Record<string, string>; cwd?: string }> = [dev]) => {
  const run = vi.fn<(...args: unknown[]) => Promise<{ exitCode: number; stdout: string }>>(async () => ({ exitCode: 0, stdout: "" }));
  const list = vi.fn(async () => processes);
  const sandbox = fromE2bSandbox({ sandboxId: `recovery-${sequence++}`, commands: { list, run } } as unknown as E2bSandbox);
  return { sandbox, run, list };
};
afterEach(() => vi.useRealTimers());

describe("recoverEsbuild (#776)", () => {
  it("kills every marked dev server and starts one in its own group with the same command, env and cwd", async () => {
    const { sandbox, run } = fakeSandbox([dev, { ...dev, pid: 30 }, { ...dev, pid: 2, envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
    expect(run.mock.calls).toEqual([
      [READ_DEV_PGID_COMMAND, bounds],
      [killDevServersCommand([12, 30]), bounds],
      [killProjectNodesCommand(dev.cwd), bounds],
      [DEV_START_COMMAND, { cwd: dev.cwd, envs: dev.envs, ...start }],
    ]);
    expect(await recoverEsbuild(sandbox)).toBe("limited");
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("restarts a Next dev server with its own marked command, not a Vite one", async () => {
    const next = { ...dev, envs: { [DEV_COMMAND_ENV]: "npm run dev -- -H 0.0.0.0", HOSTNAME: "0.0.0.0" } };
    const { sandbox, run } = fakeSandbox([next]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
    expect(run).toHaveBeenLastCalledWith(DEV_START_COMMAND, { cwd: next.cwd, envs: next.envs, ...start });
  });

  it("does nothing during an install and does not spend its attempt", async () => {
    const { sandbox, run, list } = fakeSandbox([dev, { ...dev, pid: 5, cmd: "npm", args: ["install"], envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("busy");
    expect(run).not.toHaveBeenCalled();
    list.mockResolvedValue([dev]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
  });

  it("reserves before listing commands so simultaneous errors cannot restart twice", async () => {
    const { sandbox, run, list } = fakeSandbox();
    let resolve!: (processes: typeof dev[]) => void;
    list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const first = recoverEsbuild(sandbox);
    expect(await recoverEsbuild(sandbox)).toBe("busy");
    resolve([dev]);
    expect(await first).toBe("restarted");
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("limits failed stop/start attempts too, and stops after three", async () => {
    vi.useFakeTimers();
    const { sandbox, run } = fakeSandbox();
    run.mockRejectedValue(new Error("unreachable"));
    for (let i = 0; i < 3; i++) {
      await expect(recoverEsbuild(sandbox)).rejects.toThrow("unreachable");
      expect(await recoverEsbuild(sandbox)).toBe("limited");
      vi.advanceTimersByTime(ESBUILD_RECOVERY_COOLDOWN_MS);
    }
    expect(await recoverEsbuild(sandbox)).toBe("limited");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("leaves a missing dev command to the install path (#774)", async () => {
    const { sandbox, run } = fakeSandbox([]);
    expect(await recoverEsbuild(sandbox)).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});
