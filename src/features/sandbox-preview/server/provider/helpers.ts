import { BOOT_COMMAND_ENV, DEV_COMMAND_ENV, PROXY_TARGET_ENV, killTreeCommand } from "../dev-server";
import { type RequestOptions, type RunOptions, type Sandbox, type SandboxCommand, SandboxExitError, SandboxTimeoutError } from "./types";

/**
 * Helpers every provider gets for free: they need only `run`, so an adapter
 * implements none of them.
 */

/** A process in the sandbox, read from /proc. */
export interface SandboxProcess {
  pid: number;
  ppid: number;
  /** argv[0]. */
  cmd: string;
  args: string[];
  cwd?: string;
  /**
   * The process's whole environment, inherited ones included. Children inherit a
   * marker such as CODENAYA_DEV_COMMAND, so the command that started a tree is the
   * marked process whose parent isn't marked.
   */
  envs: Record<string, string>;
}

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One line per process: pid, ppid, cwd, then base64 of the NUL-separated cmdline and environ. */
const LIST_PROCESSES =
  `for d in /proc/[0-9]*; do p=\${d#/proc/}; [ "$p" = "$$" ] && continue; ` +
  `cmd=$(base64 -w0 2>/dev/null < "$d/cmdline") || continue; [ -n "$cmd" ] || continue; ` +
  `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$(sed -n 's/^PPid:[[:space:]]*//p' "$d/status" 2>/dev/null)" ` +
  `"$(readlink "$d/cwd" 2>/dev/null)" "$cmd" "$(base64 -w0 2>/dev/null < "$d/environ")"; done`;

const nulSeparated = (base64: string) => Buffer.from(base64, "base64").toString("utf8").split("\0").filter(Boolean);

/** Parses LIST_PROCESSES output; a process that exited mid-listing leaves a short line and is skipped. */
export const parseProcesses = (stdout: string): SandboxProcess[] =>
  stdout.split("\n").flatMap((line) => {
    const [pid, ppid, cwd, cmdline, environ] = line.split("\t");
    const argv = cmdline ? nulSeparated(cmdline) : [];
    if (!Number(pid) || environ === undefined || !argv.length) return [];
    const envs = Object.fromEntries(
      nulSeparated(environ).flatMap((entry) => {
        const separator = entry.indexOf("=");
        return separator > 0 ? [[entry.slice(0, separator), entry.slice(separator + 1)]] : [];
      }),
    );
    return [{ pid: Number(pid), ppid: Number(ppid) || 0, cmd: argv[0], args: argv.slice(1), cwd: cwd || undefined, envs }];
  });

/** Every process the sandbox user can see, except the listing itself. */
export const listProcesses = async (sandbox: Sandbox, opts: RequestOptions = {}) =>
  parseProcesses((await sandbox.run(LIST_PROCESSES, { ...opts, timeoutMs: 10_000 })).stdout);

/**
 * A command the preview started, by the marker it set: the dev server, the proxy or
 * the tagged install. Provenance, not command text: an unmarked `npm install` is not ours.
 */
const isBootCommand = ({ pid, cmd, envs }: SandboxProcess) =>
  pid !== 1 && !/(^|\/)envd$/.test(cmd) &&
  Boolean(envs[DEV_COMMAND_ENV] || envs[PROXY_TARGET_ENV] || envs[BOOT_COMMAND_ENV]);

/**
 * The boot's commands among /proc's processes, one per tree: a boot command whose
 * parent is not one too. Never PID 1, envd or any other process, so resume
 * cleanup can't kill the process manager or something it didn't start.
 */
export const commandRoots = (processes: SandboxProcess[]) => {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return processes.filter((process) => {
    const parent = byPid.get(process.ppid);
    return isBootCommand(process) && !(parent && isBootCommand(parent));
  });
};

/**
 * The commands running in the sandbox. Without the provider's own list, the boot
 * commands' /proc tree roots stand in, each with its whole inherited environment,
 * so a restart from one passes more envs than the start did.
 */
export const listCommands = async (sandbox: Sandbox, opts?: RequestOptions): Promise<SandboxCommand[]> =>
  sandbox.listCommands ? sandbox.listCommands(opts) : commandRoots(await listProcesses(sandbox, opts));

/** SIGKILLs `pid` and everything under it (see killTreeCommand). */
export const killTree = (sandbox: Sandbox, pid: number, opts: RequestOptions & { timeoutMs?: number } = {}) =>
  sandbox.run(killTreeCommand(pid), opts);

/** True for a dangling symlink too, as E2B's files.exists is. */
export const exists = async (sandbox: Sandbox, path: string, opts: RequestOptions = {}) =>
  (await sandbox.run(`test -e ${quote(path)} || test -L ${quote(path)}`, opts)).exitCode === 0;

export const remove = async (sandbox: Sandbox, path: string, opts: RequestOptions = {}) => {
  const result = await sandbox.run(`rm -rf -- ${quote(path)}`, opts);
  if (result.exitCode !== 0) throw new Error(`Could not remove ${path}: ${result.stderr.trim()}`);
};

/** `run`, but a non-zero exit throws SandboxExitError, as E2B's own `commands.run` throws CommandExitError. */
export const runOrThrow = async (sandbox: Sandbox, command: string, opts?: RunOptions) => {
  const result = await sandbox.run(command, opts);
  if (result.exitCode !== 0) throw new SandboxExitError(result);
  return result;
};

/** Rejects with a SandboxTimeoutError after `ms`. The underlying request is not aborted. */
export const withDeadline = <T>(promise: Promise<T>, ms: number, what = "request"): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxTimeoutError(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};
