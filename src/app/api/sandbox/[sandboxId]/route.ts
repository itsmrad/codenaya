import { Sandbox } from "e2b";
import { auth } from "@clerk/nextjs/server";

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
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sandboxId } = await params;

  try {
    const sandbox = await Sandbox.connect(sandboxId);
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
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sandboxId } = await params;

  const body = await request.json();
  const { files } = body as {
    files: { path: string; content: string }[];
  };

  if (!files || files.length === 0) {
    return Response.json({ error: "No files provided" }, { status: 400 });
  }

  const WORK_DIR = "/home/user/app";

  try {
    const sandbox = await Sandbox.connect(sandboxId);

    await Promise.all(
      files.map((file) =>
        sandbox.files.write(`${WORK_DIR}/${file.path}`, file.content)
      )
    );

    return Response.json({ success: true, synced: files.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
