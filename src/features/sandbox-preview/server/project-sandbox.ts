import { Sandbox, type SandboxOpts } from "e2b";
import { z } from "zod";

import { killTreeCommand, SHORT_CALL_MS, stopDevServers } from "./dev-server";

/**
 * Sandbox setup shared by the preview route and the agent's checkBuild tool,
 * so both run a project in the same image, at the same path.
 */

/**
 * The base image ships Node 20.9, too old for Vite 7 (#178). E2B_TEMPLATE
 * points at the Node 22 template built by `npm run e2b:template`.
 */
export const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE?.trim() || "base";

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
export const atLiveSandboxCap = async (apiKey: string, userId: string) => {
  const running = await Sandbox.list({
    apiKey,
    query: { metadata: { userId }, state: ["running"] },
    limit: MAX_LIVE_SANDBOXES,
  }).nextItems();
  return running.length >= MAX_LIVE_SANDBOXES;
};

/**
 * Kills `userId`'s running previews of `projectId`, so reopening a project
 * replaces a preview whose tab closed without its DELETE instead of stacking
 * on it or hitting the cap (#492). Returns the killed sandbox ids.
 */
// shortcut: an orphan whose project is never reopened lives until the E2B
// timeout (SANDBOX_TIMEOUT_MS). Use a renewable lease if that ever matters.
export const killProjectPreviews = async (
  apiKey: string,
  userId: string,
  projectId: string,
) => {
  const running = await Sandbox.list({
    apiKey,
    query: { metadata: { userId, projectId }, state: ["running"] },
    limit: MAX_LIVE_SANDBOXES,
  }).nextItems();
  await Promise.all(running.map(({ sandboxId }) => Sandbox.kill(sandboxId, { apiKey })));
  return running.map(({ sandboxId }) => sandboxId);
};

export const createProjectSandbox = (
  opts: Pick<SandboxOpts, "apiKey" | "timeoutMs" | "metadata" | "network" | "requestTimeoutMs">,
) => Sandbox.create(SANDBOX_TEMPLATE, opts);

/**
 * One batched upload; E2B creates the parent directories. `timeLeft` bounds
 * each request by what is left of the caller's budget.
 */
export const writeProjectFiles = async (
  sandbox: Sandbox,
  files: ProjectFile[],
  dir = WORK_DIR,
  timeLeft?: () => number,
) => {
  await sandbox.files.makeDir(dir, { requestTimeoutMs: timeLeft?.() });
  await sandbox.files.write(
    files.map((file) => ({ path: `${dir}/${file.path}`, data: file.content })),
    { requestTimeoutMs: timeLeft?.() },
  );
};

/**
 * Stops every command an earlier boot left running (install, dev server,
 * proxy), so booting again on the same sandbox doesn't race it (#492).
 */
export const stopSandboxCommands = async (sandbox: Sandbox) => {
  const running = await sandbox.commands.list({ requestTimeoutMs: SHORT_CALL_MS });
  try {
    await stopDevServers(sandbox, running, WORK_DIR);
  } catch {
    // Best-effort cleanup: retry the listed trees below if group cleanup failed.
  }
  await Promise.all(running.map(async (command) => {
    try {
      await sandbox.commands.run(killTreeCommand(command.pid), { timeoutMs: 10_000 });
    } catch {
      // Best-effort cleanup must not prevent a resumed boot (#486).
      await sandbox.commands.kill(command.pid, { requestTimeoutMs: 10_000 }).catch(() => {
        console.warn("[project-sandbox] Failed to stop command", command.pid);
      });
    }
  }));
};
