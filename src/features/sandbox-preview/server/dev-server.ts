import type { Sandbox } from "e2b";

/**
 * Set on the dev server's E2B process to its own command line, so any server
 * instance can find it in `commands.list()` and start it again the same way.
 */
export const DEV_COMMAND_ENV = "CODENAYA_DEV_COMMAND";

/**
 * SIGKILLs `pid` and every process under it, root first. E2B's `commands.kill`
 * signals only the `bash -l -c` wrapper (envd `sysSignal`), which would leave
 * npm and Vite serving. Children are found by `PPid:` in /proc, which needs no
 * procps and no CONFIG_PROC_CHILDREN.
 */
export const killTreeCommand = (pid: number) =>
  `kids() { grep -l "^PPid:[[:space:]]*$1$" /proc/[0-9]*/status 2>/dev/null | cut -d/ -f3; }; ` +
  `tree() { echo "$1"; for c in $(kids "$1"); do tree "$c"; done; }; ` +
  `kill -9 $(tree ${Math.trunc(pid)}) 2>/dev/null; true`;

interface DevOutput {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** How the boot started the dev server, for when none is running to copy. */
export interface DevStart {
  command: string;
  envs: Record<string, string>;
  cwd?: string;
}

/** A listening socket is ready even while Next compiles its first HTTP response. */
export const isPortOpen = async (sandbox: Sandbox, port: number): Promise<boolean> => {
  try {
    const result = await sandbox.commands.run(
      `node -e 'const socket=require("net").connect({host:"localhost",port:${port}});` +
        `socket.setTimeout(1500);socket.once("connect",()=>{console.log("open");socket.destroy()});` +
        `socket.once("timeout",()=>socket.destroy());socket.once("error",()=>{});'`,
      { timeoutMs: 3000 },
    );
    return result.stdout.trim() === "open";
  } catch {
    // A refused connection or probe timeout is retried by the readiness loop.
    return false;
  }
};

/**
 * Runs `install` with the dev server stopped, then starts it once with the same
 * command and env, also after a failed install. Every marked process is
 * stopped: a resumed boot or another instance can leave two. With none
 * running, `fallback` starts one, so a lost start heals on the next install.
 * A Vite serving while npm
 * rewrites node_modules re-optimizes mid-load, and the page runs two copies of
 * React ("Invalid hook call", #486). The page's Vite client polls until the
 * server is back, then reloads.
 */
export const installWithDevServerStopped = async <T>(
  sandbox: Sandbox,
  install: () => Promise<T>,
  output: DevOutput = {},
  fallback?: DevStart,
): Promise<T> => {
  const running = (await sandbox.commands.list()).filter((command) => command.envs?.[DEV_COMMAND_ENV]);
  for (const dev of running) await sandbox.commands.run(killTreeCommand(dev.pid));
  const [dev] = running;
  const start = dev ? { command: dev.envs[DEV_COMMAND_ENV], envs: dev.envs, cwd: dev.cwd } : fallback;
  try {
    return await install();
  } finally {
    if (start) {
      await sandbox.commands.run(start.command, {
        cwd: start.cwd,
        envs: start.envs,
        background: true,
        timeoutMs: 0, // Like the boot's: E2B would kill it after 60s.
        ...output,
      });
    }
  }
};
