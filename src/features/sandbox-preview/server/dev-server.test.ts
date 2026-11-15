import type { Sandbox } from "e2b";
import { describe, expect, it, vi } from "vitest";

import { DEV_COMMAND_ENV, installWithDevServerStopped, killTreeCommand } from "./dev-server";

const fakeSandbox = (processes: Array<{ pid: number; envs: Record<string, string>; cwd?: string }>) => {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
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

  it("only installs when no dev server is running", async () => {
    const { sandbox, run } = fakeSandbox([{ pid: 3, envs: {} }]);

    await installWithDevServerStopped(sandbox, async () => undefined);

    expect(run).not.toHaveBeenCalled();
  });

  it("names only the given pid in the kill command", () => {
    expect(killTreeCommand(12)).toContain("$(tree 12)");
    expect(killTreeCommand(12)).not.toMatch(/pkill|killall/);
  });
});
