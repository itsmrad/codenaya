import type { Sandbox } from "e2b";
import { appendHostFlag, detectFrameworkFromFiles } from "../utils/dev-command";

/**
 * Set on the dev server's E2B process to its own command line, so any server
 * instance can find it in `commands.list()` and start it again the same way.
 */
export const DEV_COMMAND_ENV = "CODENAYA_DEV_COMMAND";

/** Written at boot by the POST route; its TARGET_PORT is the dev server's port. */
export const PROXY_SCRIPT_PATH = "/home/user/e2b-proxy.js";

/** The port the boot's proxy forwards to: exact even for a custom server.port. */
export const proxyTargetPort = async (sandbox: Sandbox): Promise<number | undefined> => {
  try {
    const script = await sandbox.files.read(PROXY_SCRIPT_PATH);
    return Number(/TARGET_PORT \|\| "(\d+)"/.exec(script)?.[1]) || undefined;
  } catch {
    // No proxy yet, or an older sandbox: the framework default below applies.
    return undefined;
  }
};

/**
 * Environment variables that force dev servers to bind to 0.0.0.0
 * instead of localhost. E2B port forwarding only works when the
 * server listens on all interfaces.
 */
export const DEV_SERVER_ENVS: Record<string, string> = {
  HOST: "0.0.0.0",           // Create React App, Vite (some versions)
  HOSTNAME: "0.0.0.0",       // Next.js
  NEXT_TELEMETRY_DISABLED: "1",
};

export class DevServerStartError extends Error {
  constructor() {
    super("The preview server did not restart after installing dependencies. Restart the preview to retry.");
  }
}

/** Listing, process metadata and cleanup share checkBuild's short-call budget. */
export const SHORT_CALL_MS = 10_000;

const DEV_PGID_FILE = "/tmp/codenaya-dev-server.pgid";

// Record inside setsid: it may fork if E2B's wrapper is already a group leader.
// The dev command runs in bash, like E2B's own `bash -l -c`: settings may use bash syntax.
export const DEV_START_COMMAND =
  `if command -v setsid >/dev/null 2>&1; then exec setsid --wait sh -c ` +
  `'echo "$$" > ${DEV_PGID_FILE}; exec bash -c "$${DEV_COMMAND_ENV}"'; ` +
  `else rm -f ${DEV_PGID_FILE}; exec bash -c "$${DEV_COMMAND_ENV}"; fi`;

/** Survives an OOM-killed E2B parent; consumed before the next start records its group. */
export const READ_DEV_PGID_COMMAND = `cat ${DEV_PGID_FILE} 2>/dev/null; rm -f ${DEV_PGID_FILE}`;

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

/**
 * Orphans retain their process group even after their parent disappears from /proc.
 * The group is signalled only while its leader still carries the dev marker, so a
 * stale record can't kill a reused group id; otherwise the listed trees are.
 */
export const killDevServersCommand = (pids: number[], pgid?: number) => {
  const trees = pids.map(killTreeCommand).join("; ");
  if (pgid === undefined || !Number.isSafeInteger(pgid) || pgid <= 1) return trees;
  return `if tr '\\0' '\\n' < /proc/${pgid}/environ 2>/dev/null | grep -q '^${DEV_COMMAND_ENV}='; then ` +
    `kill -TERM -- -${pgid} 2>/dev/null; sleep 0.5; kill -KILL -- -${pgid} 2>/dev/null; true; ` +
    `else ${trees || "true"}; fi`;
};

/**
 * Old sandboxes may have no group record; Node and /proc are present in node:22.
 * Only processes that inherited the dev marker are reaped, never e.g. a concurrent `npm install`.
 */
export const killProjectNodesCommand = (cwd: string) =>
  `node -e 'const fs = require("fs"); const cwd = process.argv[1]; ` +
  `const marked = (base) => fs.readFileSync(\`\${base}/environ\`, "latin1").split("\\0")` +
  `.some((env) => env.startsWith("${DEV_COMMAND_ENV}=")); ` +
  `for (const entry of fs.readdirSync("/proc")) { ` +
  `if (!/^[0-9]+$/.test(entry)) continue; const pid = Number(entry); const base = \`/proc/\${entry}\`; ` +
  `try { if (pid !== process.pid && fs.readlinkSync(\`\${base}/cwd\`) === cwd && ` +
  `fs.readlinkSync(\`\${base}/exe\`).endsWith("/node") && marked(base)) process.kill(pid, "SIGKILL"); ` +
  `} catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; } }' ` +
  `'${cwd.replaceAll("'", "'\"'\"'")}'`;

interface DevOutput {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** How the boot started the dev server, for when none is running to copy. */
export interface DevStart {
  command: string;
  envs: Record<string, string>;
  cwd?: string;
  /** The dev server's local port; once set, a restart must listen on it within 10 s. */
  readyPort?: number;
}

/**
 * The start for a sync that finds no marked dev server, framework-aware like
 * the boot's. Project env is not known here, only the bind variables.
 */
export const fallbackDevStart = (
  files: { path: string; content: string }[],
  devCommand: string | undefined,
  cwd: string,
  proxyPort?: number,
): DevStart => {
  const framework = detectFrameworkFromFiles(files, devCommand);
  const command = appendHostFlag(devCommand || "npm run dev", framework);
  // A sync carries only changed files, so non-Next means Vite even without vite.config.
  const readyPort = proxyPort ?? (framework === "next" ? 3000 : 5173);
  return { command, cwd, envs: { ...DEV_SERVER_ENVS, [DEV_COMMAND_ENV]: command }, readyPort };
};

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

/** The proxy can survive a dead dev server; background:true alone is not readiness (#774). */
const waitForDevServer = async (sandbox: Sandbox, port: number) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isPortOpen(sandbox, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new DevServerStartError();
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
  const running = await sandbox.commands.list({ requestTimeoutMs: SHORT_CALL_MS });
  await stopDevServers(sandbox, running, fallback?.cwd);
  const [dev] = running.filter((command) => command.envs?.[DEV_COMMAND_ENV]);
  // A marked server keeps its command/env; the caller still knows its port.
  const start = dev ? { ...devStartOf(dev), readyPort: fallback?.readyPort } : fallback;
  try {
    return await install();
  } finally {
    // Another instance may have started one during this install: narrows that race, a lock would close it.
    const startedElsewhere = !dev && start && (await sandbox.commands.list()).some((command) => command.envs?.[DEV_COMMAND_ENV]);
    if (start && !startedElsewhere) await startDevServer(sandbox, start, output);
    else if (start?.readyPort) await waitForDevServer(sandbox, start.readyPort);
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
  const running = await sandbox.commands.list({ requestTimeoutMs: timeoutMs });
  if (running.some((command) => INSTALLING.test([command.cmd, ...command.args].join(" ")))) return false;
  await stopDevServers(sandbox, running, start.cwd, timeoutMs);
  await startDevServer(sandbox, start, { requestTimeoutMs: timeoutMs });
  return true;
};

type ListedCommand = Awaited<ReturnType<Sandbox["commands"]["list"]>>[number];

const devStartOf = (dev: ListedCommand): DevStart => ({ command: dev.envs[DEV_COMMAND_ENV], envs: dev.envs, cwd: dev.cwd });

/** Stops marked servers and project Node orphans before an install, restart or resumed boot. */
export const stopDevServers = async (sandbox: Sandbox, commands: ListedCommand[], cwd?: string, timeoutMs = SHORT_CALL_MS) => {
  const running = commands.filter((command) => command.envs?.[DEV_COMMAND_ENV]);
  if (!running.length && !cwd) return;
  const bounds = { timeoutMs: Math.min(timeoutMs, SHORT_CALL_MS), requestTimeoutMs: Math.min(timeoutMs, SHORT_CALL_MS) };
  const { stdout } = await sandbox.commands.run(READ_DEV_PGID_COMMAND, bounds);
  const kill = killDevServersCommand(running.map((dev) => dev.pid), Number(stdout.trim()));
  if (kill) await sandbox.commands.run(kill, bounds);
  for (const dir of new Set([cwd, ...running.map((dev) => dev.cwd)])) {
    if (dir) await sandbox.commands.run(killProjectNodesCommand(dir), bounds);
  }
};

/** Starts the dev server in its own recorded process group; the boot uses it directly. */
export const runDevServer = (sandbox: Sandbox, start: DevStart, output: DevOutput & { requestTimeoutMs?: number } = {}) =>
  sandbox.commands.run(DEV_START_COMMAND, {
    cwd: start.cwd,
    envs: { ...start.envs, [DEV_COMMAND_ENV]: start.command },
    background: true,
    timeoutMs: 0, // Like the boot's: E2B would kill it after 60s.
    ...output,
    requestTimeoutMs: Math.min(output.requestTimeoutMs ?? SHORT_CALL_MS, SHORT_CALL_MS),
  });

/** Waits for `readyPort` when given; any failure is the safe DevServerStartError. */
const startDevServer = async (sandbox: Sandbox, start: DevStart, output: DevOutput & { requestTimeoutMs?: number } = {}) => {
  try {
    await runDevServer(sandbox, start, output);
    if (start.readyPort) await waitForDevServer(sandbox, start.readyPort);
  } catch {
    // Process errors can include project env values; expose only our safe message.
    throw new DevServerStartError();
  }
};
