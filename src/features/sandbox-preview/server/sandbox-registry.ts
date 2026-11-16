import { parseProviderConfig } from "./provider/config";
import { canonicalSandboxIdOrNull, parsePublicSandboxIdOrNull, toPublicSandboxId } from "./provider/ids";
import { getProvider } from "./provider/registry";
import { type Sandbox, SandboxNotFoundError } from "./provider/types";

interface OwnedSandbox {
  sandbox: Sandbox;
  userId: string;
  /** Re-runs the install through the boot stream; only on the instance that booted it. */
  reinstall?: () => void;
  reinstallDone?: () => Promise<void>;
}

/**
 * Connected sandbox handles by public sandbox id, so each preview file sync skips
 * `connect` + `info` (~2s of the edit→preview latency, #179).
 *
 * On `globalThis` because `next dev` may load each route in its own module
 * instance. The cache is per server instance: one that did not create the
 * sandbox connects once, checks the owner and caches the handle.
 */
const globalForSandboxes = globalThis as typeof globalThis & {
  __codenayaSandboxes?: Map<string, OwnedSandbox>;
};
const sandboxes = (globalForSandboxes.__codenayaSandboxes ??= new Map());

export const rememberSandbox = (
  sandbox: Sandbox,
  userId: string,
  reinstall?: () => void,
  reinstallDone?: () => Promise<void>,
) => {
  sandboxes.set(toPublicSandboxId(sandbox.provider, sandbox.id), { sandbox, userId, reinstall, reinstallDone });
};

/**
 * Asks the instance that booted the sandbox to re-run its install, so the
 * output reaches the preview terminal. `false` when this instance didn't boot it.
 */
/** The cache entry for a client id, prefixed or not. */
const cached = (sandboxId: string) => sandboxes.get(canonicalSandboxIdOrNull(sandboxId) ?? "");

export const requestReinstall = (sandboxId: string) => {
  const reinstall = cached(sandboxId)?.reinstall;
  reinstall?.();
  return Boolean(reinstall);
};

/** A sync must not acknowledge a queued stream install while Vite is stopped (#774). */
export const waitForReinstall = (sandboxId: string) =>
  cached(sandboxId)?.reinstallDone?.() ?? Promise.resolve();

export const forgetSandbox = (sandboxId: string) => {
  sandboxes.delete(canonicalSandboxIdOrNull(sandboxId) ?? "");
};

/**
 * The sandbox when `userId` owns it, `null` when someone else does, the id is
 * malformed or its provider is not configured: all alike, so a caller can't probe
 * which providers or sandboxes exist. A sandbox the provider no longer has
 * (expired, killed) is null too; any other provider failure rejects.
 */
export const getOwnedSandbox = async (
  sandboxId: string,
  userId: string,
): Promise<Sandbox | null> => {
  // The id comes from the client: its prefix only picks the provider, the owner is checked below.
  const parsed = parsePublicSandboxIdOrNull(sandboxId);
  if (!parsed) return null;
  const key = toPublicSandboxId(parsed.provider, parsed.nativeId);
  let owned = sandboxes.get(key);

  if (!owned) {
    if (!parseProviderConfig().configured[parsed.provider]) return null;
    let sandbox: Sandbox;
    let ownerId: string | undefined;
    try {
      sandbox = await getProvider(parsed.provider).connect(parsed.nativeId);
      ownerId = (await sandbox.info()).metadata?.userId;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    }

    if (ownerId !== userId) {
      return null;
    }

    owned = { sandbox, userId: ownerId };
    sandboxes.set(key, owned);
  }

  return owned.userId === userId ? owned.sandbox : null;
};
