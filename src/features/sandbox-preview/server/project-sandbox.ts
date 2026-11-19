import { z } from "zod";

import { killTreeCommand, SHORT_CALL_MS, stopDevServers } from "./dev-server";
import { DEFAULT_E2B_TEMPLATE } from "./provider/e2b";
import { FALLBACK_LIST_TIMEOUT_MS, type FanoutHealth, listAll } from "./provider/fanout";
import { listCommands, withDeadline } from "./provider/helpers";
import { toPublicSandboxId } from "./provider/ids";
import type { Sandbox as SeamSandbox, SandboxProvider } from "./provider/types";

/**
 * Sandbox setup shared by the preview route and the agent's checkBuild tool,
 * so both run a project in the same image, at the same path.
 */

/**
 * The base image ships Node 20.9, too old for Vite 7 (#178). E2B_TEMPLATE
 * overrides the default Node 22 template built by `npm run e2b:template`.
 */
export const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE?.trim() || DEFAULT_E2B_TEMPLATE;

if (!process.env.E2B_TEMPLATE?.trim()) {
  console.warn(`[project-sandbox] E2B_TEMPLATE unset; using ${DEFAULT_E2B_TEMPLATE}. Build it with npm run e2b:template`);
}

/** Where project files are written inside the sandbox. */
export const WORK_DIR = "/home/user/app";

/**
 * `npm install` from the npm cache the E2B template warms with the starter's
 * dependencies (#338), retried once online: --prefer-offline trusts a cached
 * packument older than a newly published version, and fails ETARGET on it.
 */
// shortcut: retries on any install failure, not only ETARGET; a real failure
// runs twice. Match npm's error code first if that cost ever shows.
export const offlineFirstInstall = (flags: string) =>
  `npm install --prefer-offline ${flags} || npm install ${flags}`;

/** Install unless the project overrides it. */
export const DEFAULT_INSTALL_COMMAND = offlineFirstInstall("--no-audit --no-fund");

export type ProjectFile = { path: string; content: string };

/** The non-empty `files` batch the sandbox routes accept from the client (#235). */
export const projectFilesSchema = z
  .array(z.object({ path: z.string(), content: z.string() }))
  .min(1, "No files provided");

/** Live preview sandboxes per user; each runs up to an hour on our E2B key (#242). */
export const MAX_LIVE_SANDBOXES = 3;

/**
 * Whether `userId` already has MAX_LIVE_SANDBOXES running previews. E2B counts
 * them by the `userId` metadata the preview route sets, so this holds across
 * server instances.
 */
// ponytail: check-then-create, so simultaneous boots can overshoot by a few; the
// sandbox rate limit bounds that. Use a Convex counter if it ever matters.
// A non-primary provider whose list fails is left out only while it is cooling down,
// so during its outage a user can go over the cap by their sandboxes on it (ADR 0015).
export const atLiveSandboxCap = async (providers: readonly SandboxProvider[], userId: string, health?: FanoutHealth) => {
  // Each provider returns at most the cap, so the sum still answers "at the cap" exactly.
  const running = await listAll(providers, { metadata: { userId }, limit: MAX_LIVE_SANDBOXES }, health && { ...health, skip: "cooling" });
  return running.length >= MAX_LIVE_SANDBOXES;
};

/**
 * Kills `userId`'s running previews of `projectId`, so reopening a project
 * replaces a preview whose tab closed without its DELETE instead of stacking
 * on it or hitting the cap (#492). Returns the killed sandboxes' prefixed ids.
 */
// shortcut: an orphan whose project is never reopened lives until the E2B
// timeout (SANDBOX_TIMEOUT_MS). Use a renewable lease if that ever matters. Best
// effort: a non-primary provider whose list or kill fails is skipped and cooled, and
// its sandboxes expire on their TTL. Only the ids actually killed are returned.
export const killProjectPreviews = async (
  providers: readonly SandboxProvider[],
  userId: string,
  projectId: string,
  health?: FanoutHealth,
) => {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  // Only sandboxes a given provider listed can be killed through it; anything else is left alone.
  const running = (await listAll(providers, { metadata: { userId, projectId }, limit: MAX_LIVE_SANDBOXES }, health && { ...health, skip: "failing" }))
    .filter(({ provider }) => byId.has(provider));
  const killed = await Promise.all(running.map(async ({ provider, id }) => {
    const target = byId.get(provider);
    if (!target) return false;
    if (!health || provider === health.primary) {
      await target.kill(id);
      return true;
    }
    try {
      await withDeadline(target.kill(id, { requestTimeoutMs: FALLBACK_LIST_TIMEOUT_MS }), FALLBACK_LIST_TIMEOUT_MS, "kill");
      return true;
    } catch {
      health.cooldown.coolDown(provider);
      console.warn(`[sandbox-provider] Could not kill a ${provider} preview; it expires on its TTL`);
      return false;
    }
  }));
  return running.filter((_, index) => killed[index]).map(({ provider, id }) => toPublicSandboxId(provider, id));
};

/** `files` under `dir`, as one `writeFiles` batch for the provider seam. */
export const projectFileEntries = (files: ProjectFile[], dir = WORK_DIR) =>
  files.map((file) => ({ path: `${dir}/${file.path}`, data: file.content }));

/**
 * Stops every command an earlier boot left running (install, dev server,
 * proxy), so booting again on the same sandbox doesn't race it (#492).
 */
export const stopSandboxCommands = async (sandbox: SeamSandbox) => {
  const running = await listCommands(sandbox, { requestTimeoutMs: SHORT_CALL_MS });
  try {
    await stopDevServers(sandbox, running, WORK_DIR);
  } catch {
    // Best-effort cleanup: retry the listed trees below if group cleanup failed.
  }
  await Promise.all(running.map(async (command) => {
    try {
      await sandbox.run(killTreeCommand(command.pid), { timeoutMs: 10_000 });
    } catch {
      // Best-effort cleanup must not prevent a resumed boot (#486).
      const kill = sandbox.killCommand?.(command.pid, { requestTimeoutMs: 10_000 }) ?? Promise.reject();
      await kill.catch(() => {
        console.warn("[project-sandbox] Failed to stop command", command.pid);
      });
    }
  }));
};
