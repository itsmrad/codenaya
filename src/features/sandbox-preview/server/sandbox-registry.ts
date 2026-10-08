import { Sandbox } from "e2b";

interface OwnedSandbox {
  sandbox: Sandbox;
  userId: string;
}

/**
 * Connected E2B sandbox handles by sandbox id, so each preview file sync skips
 * `Sandbox.connect` + `getInfo` (~2s of the edit→preview latency, #179).
 *
 * On `globalThis` because `next dev` may load each route in its own module
 * instance. The cache is per server instance: one that did not create the
 * sandbox connects once, checks the owner and caches the handle.
 */
const globalForSandboxes = globalThis as typeof globalThis & {
  __codenayaSandboxes?: Map<string, OwnedSandbox>;
};
const sandboxes = (globalForSandboxes.__codenayaSandboxes ??= new Map());

export const rememberSandbox = (sandbox: Sandbox, userId: string) => {
  sandboxes.set(sandbox.sandboxId, { sandbox, userId });
};

export const forgetSandbox = (sandboxId: string) => {
  sandboxes.delete(sandboxId);
};

/**
 * The sandbox when `userId` owns it, `null` when someone else does. Rejects
 * when E2B cannot reach the sandbox (e.g. it already expired).
 */
export const getOwnedSandbox = async (
  sandboxId: string,
  userId: string,
): Promise<Sandbox | null> => {
  let owned = sandboxes.get(sandboxId);

  if (!owned) {
    const sandbox = await Sandbox.connect(sandboxId);
    const sandboxInfo = await sandbox.getInfo();
    const ownerId = sandboxInfo.metadata?.userId;

    if (ownerId !== userId) {
      return null;
    }

    owned = { sandbox, userId: ownerId };
    sandboxes.set(sandboxId, owned);
  }

  return owned.userId === userId ? owned.sandbox : null;
};
