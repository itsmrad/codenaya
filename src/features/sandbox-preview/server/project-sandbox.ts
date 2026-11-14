import { Sandbox, type SandboxOpts } from "e2b";
import { z } from "zod";

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
 * Install unless the project overrides it. --prefer-offline uses the npm cache
 * the E2B template warms with the starter's dependencies (#338).
 */
export const DEFAULT_INSTALL_COMMAND = "npm install --prefer-offline --no-audit --no-fund";

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
