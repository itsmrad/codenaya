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
  const [dev] = await stopDevServers(sandbox);
  const start = dev ? devStartOf(dev) : fallback;
  try {
    return await install();
  } finally {
    if (start) await startDevServer(sandbox, start, output);
  }
};

/** Set on the preview proxy's process to the dev server port it forwards to. */
export const PROXY_TARGET_ENV = "TARGET_PORT";

/** The preview's dev server: the port its proxy forwards to, and how to start it again. */
export type PreviewDevServer = { port: number; start: DevStart };

/** This sandbox's preview dev server, or null when it has no marked dev server and proxy. */
export const findPreviewDevServer = async (sandbox: Sandbox, requestTimeoutMs?: number) => {
  const running = await sandbox.commands.list({ requestTimeoutMs });
  const port = Number(running.find((command) => command.envs?.[PROXY_TARGET_ENV])?.envs[PROXY_TARGET_ENV]);
  const dev = running.find((command) => command.envs?.[DEV_COMMAND_ENV]);
  return port && dev ? { port, start: devStartOf(dev) } : null;
};

/** An install a preview or a check runs; it stops and restarts the dev server itself (#486). */
export const INSTALLING = /\b(?:npm|pnpm|yarn|bun)\b.*\s(?:install|i|add|ci)(?:\s|$)/;

const PORT_PROBES = 3;
const PORT_PROBE_GAP_MS = 500;

/**
 * Starts the dev server again, after stopping what is left of it, when its port no
 * longer answers. A `next build` beside `next dev` in E2B's default 1 GiB sandbox
 * can get the server OOM-killed while its `next dev` parent stays listed, and the
 * preview then answers 502. Left alone while an install runs: that has it stopped
 * on purpose and starts it after. Each call is bounded by `timeoutMs`. True when it restarted.
 */
export const restartDevServerIfDown = async (sandbox: Sandbox, { port, start }: PreviewDevServer, timeoutMs: number) => {
  for (let probe = 0; probe < PORT_PROBES; probe++) {
    if (probe) await new Promise((resolve) => setTimeout(resolve, PORT_PROBE_GAP_MS));
    if (await isPortOpen(sandbox, port)) return false;
  }
  const bounds = { timeoutMs, requestTimeoutMs: timeoutMs };
  const running = await sandbox.commands.list({ requestTimeoutMs: timeoutMs });
  if (running.some((command) => INSTALLING.test([command.cmd, ...command.args].join(" ")))) return false;
  for (const dev of running.filter((command) => command.envs?.[DEV_COMMAND_ENV])) {
    await sandbox.commands.run(killTreeCommand(dev.pid), bounds);
  }
  await startDevServer(sandbox, start, { requestTimeoutMs: timeoutMs });
  return true;
};

type ListedCommand = Awaited<ReturnType<Sandbox["commands"]["list"]>>[number];

const devStartOf = (dev: ListedCommand): DevStart => ({ command: dev.envs[DEV_COMMAND_ENV], envs: dev.envs, cwd: dev.cwd });

/** Stops every marked dev server: a resumed boot or another instance can leave two. Returns them. */
const stopDevServers = async (sandbox: Sandbox) => {
  const running = (await sandbox.commands.list()).filter((command) => command.envs?.[DEV_COMMAND_ENV]);
  for (const dev of running) await sandbox.commands.run(killTreeCommand(dev.pid));
  return running;
};

const startDevServer = (sandbox: Sandbox, start: DevStart, output: DevOutput & { requestTimeoutMs?: number } = {}) =>
  sandbox.commands.run(start.command, {
    cwd: start.cwd,
    envs: start.envs,
    background: true,
    timeoutMs: 0, // Like the boot's: E2B would kill it after 60s.
    ...output,
  });
