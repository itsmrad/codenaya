import { findPreviewDevServer, PREVIEW_PROXY_PORT, SHORT_CALL_MS } from "@/features/sandbox-preview/server/dev-server";
import { listAll } from "@/features/sandbox-preview/server/provider/fanout";
import { getConfiguredProviders, getProvider } from "@/features/sandbox-preview/server/provider/registry";
import { SandboxNotFoundError } from "@/features/sandbox-preview/server/provider/types";

/** Read the editor's existing live sandbox; never create or restart one here. */
export async function currentPreviewUrl(projectId: string, userId: string) {
  const running = await listAll(getConfiguredProviders(), {
    metadata: { userId, projectId },
    requestTimeoutMs: SHORT_CALL_MS,
  });
  for (const entry of running) {
    try {
      const sandbox = await getProvider(entry.provider).connect(entry.id, { requestTimeoutMs: SHORT_CALL_MS });
      if (await findPreviewDevServer(sandbox, SHORT_CALL_MS)) {
        return await sandbox.previewUrl(PREVIEW_PROXY_PORT);
      }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
  }
  return null;
}
