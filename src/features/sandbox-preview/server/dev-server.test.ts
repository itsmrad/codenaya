import type { Sandbox } from "e2b";
import { describe, expect, it, vi } from "vitest";

import { DEV_COMMAND_ENV, installWithDevServerStopped, killTreeCommand } from "./dev-server";

const fakeSandbox = (processes: Array<{ pid: number; envs: Record<string, string>; cwd?: string }>) => {
  const run = vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const sandbox = {
    commands: { list: vi.fn(async () => processes), run },
  } as unknown as Sandbox;
  return { sandbox, run };
};

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
});
