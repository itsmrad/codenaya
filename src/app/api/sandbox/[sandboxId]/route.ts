import { z } from "zod";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { recoverEsbuild } from "@/features/sandbox-preview/server/recover-esbuild";
import {
  DEFAULT_INSTALL_COMMAND,
  projectFileEntries,
  projectFilesSchema,
} from "@/features/sandbox-preview/server/project-sandbox";
import { canonicalSandboxIdOrNull } from "@/features/sandbox-preview/server/provider/ids";
import { SandboxTimeoutError } from "@/features/sandbox-preview/server/provider/types";
import {
  forgetSandbox,
  getOwnedSandbox,
  requestReinstall,
  waitForReinstall,
} from "@/features/sandbox-preview/server/sandbox-registry";
import {
  DevServerStartError,
  fallbackDevStart,
  installWithDevServerStopped,
  proxyTargetPort,
} from "@/features/sandbox-preview/server/dev-server";
import {
  REINSTALL_DEBOUNCE_MS,
  debounceSerial,
} from "@/features/sandbox-preview/server/debounce-serial";
import {
  installFailure,
  type InstallFailure,
} from "@/features/sandbox-preview/server/install-failure";
import {
  boundedTimeout,
  streamBudget,
} from "@/features/sandbox-preview/server/stream-budget";

/** Vercel Hobby's maximum. A sync's install is bounded to answer before it (#492). */
export const maxDuration = 300;

const patchSchema = z.object({
  files: projectFilesSchema,
  installCommand: z.string().optional(),
  devCommand: z.string().optional(),
});

const recoverySchema = z.object({ action: z.literal("recover-esbuild") });
const RECOVERY_RATE_LIMIT = { scope: "sandbox-esbuild-recovery", limit: 30, windowMs: 60_000 };

type Install = () => Promise<InstallFailure | undefined>;

interface InstallQueue {
  queue: ReturnType<typeof debounceSerial>;
  /** The latest sync's install; a burst runs only the last one. */
  install: Install;
  outcome?: { failure?: InstallFailure } | { error: unknown };
  /** Syncs awaiting this queue; the last one out removes it. */
  waiting: number;
}

/**
 * One debounced, serial install per sandbox for syncs this instance handles, so
 * a burst of package.json syncs installs once and starts the dev server once (#486).
 */
const installQueues = new Map<string, InstallQueue>();

/** "abc" and "e2b:abc" are one sandbox, so they share one queue. */
const queueKey = (sandboxId: string) => canonicalSandboxIdOrNull(sandboxId) ?? sandboxId;

const installAfterBurst = async (publicId: string, install: Install) => {
  const sandboxId = queueKey(publicId);
  let entry = installQueues.get(sandboxId);
  if (!entry) {
    const created: InstallQueue = {
      install,
      waiting: 0,
      queue: debounceSerial(async () => {
        try {
          created.outcome = { failure: await created.install() };
        } catch (error) {
          created.outcome = { error };
        }
      }, REINSTALL_DEBOUNCE_MS),
    };
    installQueues.set(sandboxId, created);
    entry = created;
  }
  entry.install = install;
  entry.queue.schedule();
  entry.waiting++;
  await entry.queue.idle();
  // Idle, and nobody scheduled since: drop it, so the map doesn't grow per sandbox.
  if (--entry.waiting === 0) installQueues.delete(sandboxId);
  const outcome = entry.outcome;
  if (outcome && "error" in outcome) throw outcome.error;
  return outcome?.failure;
};

interface RouteParams {
  params: Promise<{ sandboxId: string }>;
}

/**
 * DELETE /api/sandbox/[sandboxId]
 *
 * Kills an E2B sandbox to free up the slot.
 * Called on unmount, navigation away, or manual restart.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const { sandboxId } = await params;

  try {
    const sandbox = await getOwnedSandbox(sandboxId, userId);

    if (!sandbox) {
      return Response.json({ error: "Sandbox not found" }, { status: 404 });
    }

    forgetSandbox(sandboxId);
    await sandbox.kill();

    return Response.json({ success: true });
  } catch (error) {
    // Sandbox may already be dead — that's fine
    const message = error instanceof Error ? error.message : "Unknown error";

    return Response.json(
      { success: false, error: message },
      { status: 200 } // Return 200 even on failure — sandbox is gone either way
    );
  }
}

/**
 * POST /api/sandbox/[sandboxId]?_method=DELETE
 *
 * Supports navigator.sendBeacon() cleanup and the recover-esbuild action (#776).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const url = new URL(request.url);
  const method = url.searchParams.get("_method");

  if (method === "DELETE") {
    return DELETE(request, { params });
  }

  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;
  const limit = checkRateLimit(userId, RECOVERY_RATE_LIMIT);
  if (!limit.allowed) return rateLimitedResponse(limit);
  const { invalid } = await parseJsonBody(request, recoverySchema);
  if (invalid) return invalid;
  const { sandboxId } = await params;
  try {
    const sandbox = await getOwnedSandbox(sandboxId, userId);
    if (!sandbox) return Response.json({ error: "Sandbox not found" }, { status: 404 });
    // A package.json sync may be queued but not yet visible in commands.list().
    const status = installQueues.has(queueKey(sandboxId)) ? "busy" : await recoverEsbuild(sandbox);
    return Response.json({ status });
  } catch {
    // Never return E2B exception text: it can contain the command's environment.
    console.warn("[sandbox-recovery] Dev server recovery failed");
    return Response.json({ error: "Preview recovery failed" }, { status: 502 });
  }
}

/**
 * PATCH /api/sandbox/[sandboxId]
 *
 * Syncs file changes to a running sandbox for hot-reload.
 * Accepts an array of { path, content } objects. A changed package.json
 * re-runs the install so dependencies added after the boot are there (#254).
 * A failed install answers `installFailed` with its exit code and npm error
 * code, so the preview can show it after the boot stream has ended (#497).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const budget = streamBudget(Date.now());
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const { sandboxId } = await params;

  const { data, invalid } = await parseJsonBody(request, patchSchema);

  if (invalid) {
    return invalid;
  }

  const { files, installCommand, devCommand } = data;

  const WORK_DIR = "/home/user/app";

  try {
    const sandbox = await getOwnedSandbox(sandboxId, userId);

    if (!sandbox) {
      return Response.json({ error: "Sandbox not found" }, { status: 404 });
    }

    // One request for the whole batch instead of one per file.
    await sandbox.writeFiles(projectFileEntries(files, WORK_DIR));

    // The instance that booted the sandbox installs through the boot stream,
    // where the output reaches the terminal. Any other instance, or any sync
    // after that stream has ended (#492), installs here.
    let installFailed: InstallFailure | undefined;
    if (files.some((file) => file.path === "package.json")) {
      if (requestReinstall(sandboxId)) {
        await waitForReinstall(sandboxId);
      } else {
        const command = installCommand || DEFAULT_INSTALL_COMMAND;
        let failed: InstallFailure | undefined;
        installFailed = await installAfterBurst(sandboxId, async () =>
          installWithDevServerStopped(sandbox, async () => {
            // Retain only the safe npm code for a timeout; output and exception
            // messages may include injected secrets, even ones since rotated (#498).
            let tail = "";
            let timeoutFailure: InstallFailure = { exitCode: 124 };
            const observe = (chunk: string) => {
              tail = (tail + chunk).slice(-8192);
              const failure = installFailure({ exitCode: 124, stdout: tail, stderr: "" });
              if (failure.code) timeoutFailure = failure;
            };
            // A non-zero exit resolves: it is the app's failure, not a dead sandbox (#491).
            const result = await sandbox
              .run(command, {
                cwd: WORK_DIR,
                timeoutMs: boundedTimeout(5 * 60 * 1000, budget.left()),
                onStdout: observe,
                onStderr: observe,
              })
              .catch((error: unknown) => {
                if (error instanceof SandboxTimeoutError) return null;
                throw error;
              });
            failed = !result ? timeoutFailure : result.exitCode !== 0 ? installFailure(result) : undefined;
            return failed;
          }, {}, fallbackDevStart(files, devCommand, WORK_DIR, await proxyTargetPort(sandbox))).catch((error: unknown) => {
            // The failed install is the primary error: the client offers its fix, then the next sync starts the server.
            if (failed && error instanceof DevServerStartError) return failed;
            throw error;
          }),
        );
      }
    }

    return Response.json({ success: true, synced: files.length, installFailed });
  } catch (error) {
    if (error instanceof DevServerStartError) {
      return Response.json({ success: false, error: error.message, code: "dev_server_unavailable" }, { status: 503 });
    }
    // The cached handle may belong to a sandbox that has since died.
    forgetSandbox(sandboxId);

    const message = error instanceof Error ? error.message : "Unknown error";

    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
