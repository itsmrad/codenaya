import { describe, expect, it, vi } from "vitest";

import { exists, killTree, listProcesses, parseProcesses, remove } from "./helpers";
import type { Sandbox } from "./types";

const b64 = (...parts: string[]) => Buffer.from(parts.map((part) => `${part}\0`).join("")).toString("base64");

const fakeSandbox = (result: { exitCode?: number; stdout?: string; stderr?: string } = {}) => {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", ...result });
  return { sandbox: { run } as unknown as Sandbox, run };
};

describe("parseProcesses", () => {
  it("reads pid, parent, argv, cwd and the environment", () => {
    const stdout =
      `12\t1\t/home/user/app\t${b64("/bin/bash", "-l", "-c", "npm run dev")}\t${b64("CODENAYA_DEV_COMMAND=npm run dev", "A=b=c")}\n` +
      `13\t12\t\t${b64("node", "vite")}\t\n`;

    expect(parseProcesses(stdout)).toEqual([
      {
        pid: 12,
        ppid: 1,
        cmd: "/bin/bash",
        args: ["-l", "-c", "npm run dev"],
        cwd: "/home/user/app",
        envs: { CODENAYA_DEV_COMMAND: "npm run dev", A: "b=c" },
      },
      { pid: 13, ppid: 12, cmd: "node", args: ["vite"], cwd: undefined, envs: {} },
    ]);
  });

  it("skips short lines and processes without a command line", () => {
    expect(parseProcesses(`12\t1\n\n14\t1\t/\t\t\nx\t1\t/\t${b64("sh")}\t\n`)).toEqual([]);
  });
});

describe("helpers over run", () => {
  it("lists processes with a bounded run", async () => {
    const { sandbox, run } = fakeSandbox({ stdout: `7\t1\t/\t${b64("sh")}\t\n` });

    expect(await listProcesses(sandbox, { requestTimeoutMs: 5 })).toEqual([
      { pid: 7, ppid: 1, cmd: "sh", args: [], cwd: "/", envs: {} },
    ]);
    expect(run).toHaveBeenCalledWith(expect.stringContaining("/proc/[0-9]*"), { requestTimeoutMs: 5, timeoutMs: 10_000 });
  });

  it("kills a process tree", async () => {
    const { sandbox, run } = fakeSandbox();

    await killTree(sandbox, 42);

    expect(run.mock.calls[0][0]).toContain("tree 42");
  });

  it("tells whether a path exists, quoting it", async () => {
    const { sandbox, run } = fakeSandbox({ exitCode: 1 });

    expect(await exists(sandbox, "/app/it's here")).toBe(false);
    expect(run).toHaveBeenCalledWith(`test -e '/app/it'\\''s here'`, {});
  });

  it("removes a path and throws when rm fails", async () => {
    const ok = fakeSandbox();
    await remove(ok.sandbox, "/app/dist");
    expect(ok.run).toHaveBeenCalledWith(`rm -rf -- '/app/dist'`, {});

    await expect(remove(fakeSandbox({ exitCode: 1, stderr: "busy\n" }).sandbox, "/x")).rejects.toThrow("Could not remove /x: busy");
  });
});
