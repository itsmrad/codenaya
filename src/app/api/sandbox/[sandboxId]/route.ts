import { z } from "zod";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";
import {
  forgetSandbox,
  getOwnedSandbox,
} from "@/features/sandbox-preview/server/sandbox-registry";

interface RouteParams {
  params: Promise<{ sandboxId: string }>;
}

const sandboxPatchSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1, "No files provided"),
});

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
 * Accepts an array of { path, content } objects.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const { sandboxId } = await params;

  const parsed = await parseJsonBody(request, sandboxPatchSchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { files } = parsed.data;

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

    return Response.json({ success: true, synced: files.length });
  } catch (error) {
    // The cached handle may belong to a sandbox that has since died.
    forgetSandbox(sandboxId);

    const message = error instanceof Error ? error.message : "Unknown error";

    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
