import { CommandExitError, TimeoutError } from "e2b";
import { z } from "zod";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";
import {
  DEFAULT_INSTALL_COMMAND,
  projectFilesSchema,
} from "@/features/sandbox-preview/server/project-sandbox";
import {
  forgetSandbox,
  getOwnedSandbox,
  requestReinstall,
} from "@/features/sandbox-preview/server/sandbox-registry";
import { RESTART_VITE_COMMAND } from "@/features/sandbox-preview/server/restart-vite";
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
});

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
 * Supports navigator.sendBeacon() which can only send POST requests.
 * Used for cleanup during page unload (tab close, navigation away).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const url = new URL(request.url);
  const method = url.searchParams.get("_method");

  if (method === "DELETE") {
    return DELETE(request, { params });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
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

  const { files, installCommand } = data;

  const WORK_DIR = "/home/user/app";

  try {
    const sandbox = await getOwnedSandbox(sandboxId, userId);

    if (!sandbox) {
      return Response.json({ error: "Sandbox not found" }, { status: 404 });
    }

    // One request for the whole batch instead of one per file.
    await sandbox.files.write(
      files.map((file) => ({
        path: `${WORK_DIR}/${file.path}`,
        data: file.content,
      }))
    );

    // The instance that booted the sandbox installs through the boot stream,
    // where the output reaches the terminal. Any other instance, or any sync
    // after that stream has ended (#492), installs here.
    let installFailed: InstallFailure | undefined;
    if (
      files.some((file) => file.path === "package.json") &&
      !requestReinstall(sandboxId)
    ) {
      const command = installCommand || DEFAULT_INSTALL_COMMAND;
      // Retain only the safe npm code for a timeout; output and exception
      // messages may include injected secrets, even ones since rotated (#498).
      let tail = "";
      let timeoutFailure: InstallFailure = { exitCode: 124 };
      const observe = (chunk: string) => {
        tail = (tail + chunk).slice(-8192);
        const failure = installFailure({ exitCode: 124, stdout: tail, stderr: "" });
        if (failure.code) timeoutFailure = failure;
      };
      const result = await sandbox.commands
        .run(command, {
          cwd: WORK_DIR,
          timeoutMs: boundedTimeout(5 * 60 * 1000, budget.left()),
          onStdout: observe,
          onStderr: observe,
        })
        .catch((error: unknown) => {
          // A non-zero exit is the app's failure, not a dead sandbox (#491).
          if (error instanceof CommandExitError) return error;
          if (error instanceof TimeoutError) {
            installFailed = timeoutFailure;
            return null;
          }
          throw error;
        });
      if (result && result.exitCode !== 0) {
        installFailed = installFailure(result);
      } else if (result) {
        await sandbox.commands.run(RESTART_VITE_COMMAND, { cwd: WORK_DIR });
      }
    }

    return Response.json({ success: true, synced: files.length, installFailed });
  } catch (error) {
    // The cached handle may belong to a sandbox that has since died.
    forgetSandbox(sandboxId);

    const message = error instanceof Error ? error.message : "Unknown error";

    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
