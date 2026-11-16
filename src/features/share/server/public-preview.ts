import type { FunctionReturnType } from "convex/server";
import { createHash, randomUUID } from "node:crypto";
import { convex } from "@/lib/convex-client";
import { createSandbox, getProvider } from "@/features/sandbox-preview/server/provider/registry";
import { parsePublicSandboxIdOrNull, toPublicSandboxId } from "@/features/sandbox-preview/server/provider/ids";
import { SandboxNotFoundError } from "@/features/sandbox-preview/server/provider/types";
import { publicPreviewOrigins } from "./frame-origins";
import { startProductionSite } from "./production-site";
import { api } from "../../../../convex/_generated/api";

const key = () => process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
export const previewState = (token: string, revision?: string, retry?: boolean) => convex.mutation(api.publicPreviews.claim, { internalKey: key(), token, lease: randomUUID(), revision, retry });
export type PreviewState = Awaited<ReturnType<typeof previewState>>;
const update = (token: string, lease: string, extra: { sandboxId?: string; url?: string; ready?: boolean; release?: boolean; heartbeat?: boolean; failed?: boolean }) =>
  convex.mutation(api.publicPreviews.update, { internalKey: key(), token, lease, ...extra });

export async function retirePreview(token: string, state: PreviewState) {
  const id = state.sandboxId && parsePublicSandboxIdOrNull(state.sandboxId);
  if (id) await getProvider(id.provider).kill(id.nativeId);
  if (state.lease) await update(token, state.lease, { release: true });
}

export async function heartbeatPreview(token: string, state: PreviewState) {
  if (!state.sandboxId || !state.lease) return state;
  const id = parsePublicSandboxIdOrNull(state.sandboxId);
  if (!id) throw new Error("Invalid saved sandbox");
  const until = await update(token, state.lease, { heartbeat: true });
  if (!until) return { status: "missing" as const };
  try {
    await getProvider(id.provider).connect(id.nativeId, { timeoutMs: Math.max(1000, until - Date.now() - 1000), requestTimeoutMs: 10_000 });
    return state;
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
    await update(token, state.lease, { release: true });
    return { status: "boot" as const };
  }
}

/** Read-only: checking saved inputs must not reserve or retire a sandbox. */
export async function readPreviewInputs(token: string) {
  const manifest = await convex.query(api.publicPreviews.manifest, { internalKey: key(), token });
  if (!manifest) return null;
  // Storage URLs rotate: use the persistent path/content and a stable URL pathname.
  const revision = createHash("sha256").update(JSON.stringify({ runtime: "frame-origins-v2", frameOrigins: publicPreviewOrigins(), ...manifest, files: manifest.files.map(file => ({ ...file, url: file.url ? new URL(file.url).pathname : null })) })).digest("hex");
  return { manifest, revision };
}

export async function preparePreview(token: string, inputs?: Awaited<ReturnType<typeof readPreviewInputs>>, retry?: boolean): Promise<{ state: PreviewState; manifest?: NonNullable<FunctionReturnType<typeof api.publicPreviews.manifest>> }> {
  const loaded = inputs === undefined ? await readPreviewInputs(token) : inputs;
  if (!loaded) return { state: { status: "missing" as const } };
  const { manifest, revision } = loaded;
  let state = await previewState(token, revision, retry);
  if (state.status === "retire") {
    await retirePreview(token, state);
    state = await previewState(token, revision);
  }
  return { state, manifest };
}

export async function bootPreview(token: string, prepared: Awaited<ReturnType<typeof preparePreview>>) {
  const { state, manifest } = prepared;
  if (state.status !== "boot" || !state.lease || !state.until || !manifest) return;
  let sandbox;
  try {
    const allowedOrigins = publicPreviewOrigins();
    sandbox = await createSandbox({ timeoutMs: Math.max(1000, state.until - Date.now() - 1000), metadata: { publicShare: token }, localHostHeader: true, requestTimeoutMs: 15_000 });
    const sandboxId = toPublicSandboxId(sandbox.provider, sandbox.id);
    if (!await update(token, state.lease, { sandboxId })) { await sandbox.kill(); return; }
    const files = await Promise.all(manifest.files.map(async file => {
      if (!file.url) return { path: file.path, data: file.content ?? "" };
      const response = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Asset unavailable");
      return { path: file.path, data: await response.arrayBuffer() };
    }));
    const url = await startProductionSite(sandbox, files, manifest.env, allowedOrigins);
    if (!await update(token, state.lease, { ready: true, url })) await sandbox.kill();
  } catch {
    await update(token, state.lease, { failed: true });
    // A failed kill keeps the reservation until the provider's hard timeout.
    if (sandbox) {
      await sandbox.kill();
      await update(token, state.lease, { release: true, failed: true });
    }
  }
}
