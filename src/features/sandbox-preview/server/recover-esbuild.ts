import type { Sandbox } from "e2b";
import { DEV_COMMAND_ENV, runDevServer, stopDevServers } from "./dev-server";
import { nextEsbuildRecovery, type EsbuildRecoveryAttempts, type EsbuildRecoveryStatus } from "../utils/esbuild-recovery";

interface Recovery extends EsbuildRecoveryAttempts {
  pending: boolean;
  expiresAt: number;
}

// Like the route rate limiter, this is per instance and resets on cold starts.
// Keep it across Next dev route reloads; sandboxes expire after at most one hour.
const globalForRecovery = globalThis as typeof globalThis & {
  __codenayaEsbuildRecovery?: Map<string, Recovery>;
};
const recoveries = (globalForRecovery.__codenayaEsbuildRecovery ??= new Map());
const INSTALLING = /\b(?:npm|pnpm|yarn|bun)\b.*\s(?:install|i|add|ci)(?:\s|$)/;

/** Reuse #661's marked-tree stop/start; never kill the proxy or unrelated commands. */
export const recoverEsbuild = async (sandbox: Sandbox): Promise<EsbuildRecoveryStatus> => {
  const now = Date.now();
  for (const [id, state] of recoveries) {
    if (!state.pending && state.expiresAt <= now) recoveries.delete(id);
  }
  const previous = recoveries.get(sandbox.sandboxId);
  if (previous?.pending) return "busy";
  const next = nextEsbuildRecovery(previous, now);
  if (!next || (recoveries.size >= 10_000 && !previous)) return "limited";
  // Reserve synchronously, before commands.list() yields to a duplicate request.
  const state = { ...next, pending: true, expiresAt: previous?.expiresAt ?? now + 60 * 60_000 };
  recoveries.set(sandbox.sandboxId, state);
  let attempted = false;
  try {
    const commands = await sandbox.commands.list();
    if (commands.some((command) => INSTALLING.test([command.cmd, ...command.args].join(" ")))) return "busy";
    const running = commands.filter((command) => command.envs?.[DEV_COMMAND_ENV]);
    const [dev] = running;
    if (!dev) return "unavailable"; // #774 owns starting a missing dev command after installs.
    attempted = true;
    await stopDevServers(sandbox, commands, dev.cwd);
    await runDevServer(sandbox, { command: dev.envs[DEV_COMMAND_ENV], envs: dev.envs, cwd: dev.cwd });
    return "restarted";
  } finally {
    state.pending = false;
    // Waiting for an install does not spend a recovery attempt.
    if (!attempted) {
      if (previous) recoveries.set(sandbox.sandboxId, previous);
      else recoveries.delete(sandbox.sandboxId);
    }
  }
};
