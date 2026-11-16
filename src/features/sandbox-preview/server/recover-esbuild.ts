import { DEV_COMMAND_ENV, runDevServer, stopDevServers, SHORT_CALL_MS } from "./dev-server";
import { detectFrameworkFromFiles } from "../utils/dev-command";
import { listCommands, runOrThrow } from "./provider/helpers";
import type { Sandbox } from "./provider/types";
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
const INSTALLING = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)(?=\s|$)/;

/** Reuse #661's marked-tree stop/start; never kill the proxy or unrelated commands. */
export const recoverEsbuild = async (sandbox: Sandbox): Promise<EsbuildRecoveryStatus> => {
  const now = Date.now();
  for (const [id, state] of recoveries) {
    if (!state.pending && state.expiresAt <= now) recoveries.delete(id);
  }
  const previous = recoveries.get(sandbox.id);
  if (previous?.pending) return "busy";
  const next = nextEsbuildRecovery(previous, now);
  if (!next || (recoveries.size >= 10_000 && !previous)) return "limited";
  // Reserve synchronously, before listCommands() yields to a duplicate request.
  const state = { ...next, pending: true, expiresAt: previous?.expiresAt ?? now + 60 * 60_000 };
  recoveries.set(sandbox.id, state);
  let attempted = false;
  try {
    const commands = await listCommands(sandbox);
    if (commands.some((command) => INSTALLING.test([command.cmd, ...command.args].join(" ")))) return "busy";
    const running = commands.filter((command) => command.envs?.[DEV_COMMAND_ENV]);
    const [dev] = running;
    if (!dev) return "unavailable"; // #774 owns starting a missing dev command after installs.
    if (!dev.cwd) return "unavailable";
    const [listing, pkg] = await Promise.all([
      runOrThrow(sandbox, "ls -1", { cwd: dev.cwd, timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS }),
      sandbox.readFile(`${dev.cwd}/package.json`, "text", { requestTimeoutMs: SHORT_CALL_MS }),
    ]);
    const files = listing.stdout.trim().split("\n").map((path) => ({ path, content: path === "package.json" ? pkg : "" }));
    const framework = detectFrameworkFromFiles(files, dev.envs[DEV_COMMAND_ENV]);
    if (framework !== "vite" && framework !== "tanstack-start") return "unavailable";
    attempted = true;
    await stopDevServers(sandbox, commands, dev.cwd);
    await runDevServer(sandbox, { command: dev.envs[DEV_COMMAND_ENV], envs: dev.envs, cwd: dev.cwd });
    return "restarted";
  } finally {
    state.pending = false;
    // Waiting for an install does not spend a recovery attempt.
    if (!attempted) {
      if (previous) recoveries.set(sandbox.id, previous);
      else recoveries.delete(sandbox.id);
    }
  }
};
