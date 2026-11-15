import type { Sandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_COMMAND_ENV, killTreeCommand } from "./dev-server";
import { recoverEsbuild } from "./recover-esbuild";
import { ESBUILD_RECOVERY_COOLDOWN_MS } from "../utils/esbuild-recovery";

const dev = { pid: 12, cmd: "bash", args: ["-c", "npm run dev"], envs: { [DEV_COMMAND_ENV]: "npm run dev -- --host", HOST: "0.0.0.0" }, cwd: "/home/user/app" };
let sequence = 0;
const fakeSandbox = (processes: Array<{ pid: number; cmd: string; args: string[]; envs: Record<string, string>; cwd?: string }> = [dev]) => {
  const run = vi.fn<(...args: unknown[]) => Promise<{ exitCode: number }>>(async () => ({ exitCode: 0 }));
  const list = vi.fn(async () => processes);
  const sandbox = { sandboxId: `recovery-${sequence++}`, commands: { list, run } } as unknown as Sandbox;
  return { sandbox, run, list };
};
afterEach(() => vi.useRealTimers());

describe("recoverEsbuild (#776)", () => {
  it("kills every marked tree and starts one with the same command, env and cwd", async () => {
    const { sandbox, run } = fakeSandbox([dev, { ...dev, pid: 30 }, { ...dev, pid: 2, envs: {} }]);
    expect(await recoverEsbuild(sandbox)).toBe("restarted");
    expect(run.mock.calls).toEqual([
      [killTreeCommand(12)], [killTreeCommand(30)],
      [dev.envs[DEV_COMMAND_ENV], { cwd: dev.cwd, envs: dev.envs, background: true, timeoutMs: 0 }],
    ]);
    expect(await recoverEsbuild(sandbox)).toBe("limited");
    expect(run).toHaveBeenCalledTimes(3);
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
    expect(run).toHaveBeenCalledTimes(2);
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
