import { findPreviewDevServer, PREVIEW_PROXY_PORT, SHORT_CALL_MS } from "@/features/sandbox-preview/server/dev-server";
import { listAll } from "@/features/sandbox-preview/server/provider/fanout";
import { fanoutHealth, getConfiguredProviders, getProvider } from "@/features/sandbox-preview/server/provider/registry";
import { SandboxNotFoundError } from "@/features/sandbox-preview/server/provider/types";
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

export class PreviewLookupRateLimitError extends Error {
  constructor(readonly limit: RateLimitResult) { super("Too many preview lookups. Try again shortly."); }
}

/** Read the editor's existing live sandbox; never create or restart one here. */
export async function currentPreviewUrl(projectId: string, userId: string) {
  // This shared boundary covers both page navigations and API polling, after ownership checks.
  const limit = checkRateLimit(userId, { scope: "owner-preview-lookup", limit: 30, windowMs: 60_000 });
  if (!limit.allowed) throw new PreviewLookupRateLimitError(limit);
  const health = fanoutHealth();
  const running = await listAll(getConfiguredProviders(), {
    metadata: { userId, projectId },
    limit: 2,
    requestTimeoutMs: SHORT_CALL_MS,
  }, { ...health, skip: "failing" });
  for (const entry of running) {
    try {
      const provider = getProvider(entry.provider);
      if (!provider.inspect) continue;
      const sandbox = await provider.inspect(entry.id, { requestTimeoutMs: SHORT_CALL_MS });
      if (await findPreviewDevServer(sandbox, SHORT_CALL_MS)) {
        return await sandbox.previewUrl(PREVIEW_PROXY_PORT);
      }
    } catch (error) {
      // A failing non-primary provider reads as "no preview", like its failing list.
      if (!(error instanceof SandboxNotFoundError) && entry.provider === health.primary) throw error;
    }
  }
  return null;
}
