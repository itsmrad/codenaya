import { killTreeCommand } from "../dev-server";
import { type RequestOptions, type RunOptions, type Sandbox, type SandboxCommand, SandboxExitError } from "./types";

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

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
 * The commands running in the sandbox. Without the provider's own list, every
 * process from /proc stands in: children too, each with its whole inherited
 * environment, so a restart from it passes more envs than the start did.
 */
// shortcut: no adapter lacks listCommands yet; keep only tree roots when one does.
export const listCommands = (sandbox: Sandbox, opts?: RequestOptions): Promise<SandboxCommand[]> =>
  sandbox.listCommands ? sandbox.listCommands(opts) : listProcesses(sandbox, opts);

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
