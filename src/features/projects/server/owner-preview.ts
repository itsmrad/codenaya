import { auth } from "@clerk/nextjs/server";

import { requireOwnedProject } from "./require-owned-project";

/** Shared by the page, its live refresh and the proxy's pre-stream 404 check. */
export async function ownerPreviewProject(
  projectId: string,
  session: Pick<Awaited<ReturnType<typeof auth>>, "userId"> | null = null,
) {
  const { userId } = session ?? await auth();
  if (!userId) return null;
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) throw new Error("Server configuration error");
  const { found } = await requireOwnedProject({ projectId, userId, internalKey });
  return found ? { project: found, userId } : null;
}
