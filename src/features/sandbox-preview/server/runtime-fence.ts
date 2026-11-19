import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { canonicalSandboxIdOrNull, parsePublicSandboxIdOrNull, toPublicSandboxId } from "./provider/ids";
import { getProvider } from "./provider/registry";
import type { Sandbox } from "./provider/types";

/** The boot read an env that changed since (or a deleted project), was replaced by a newer boot, or is blocked by an unkilled runtime. */
export class RuntimeAdmissionError extends Error {
  name = "RuntimeAdmissionError";
  constructor(reason: "replaced" | "blocked" | "outdated") {
    super(
      reason === "replaced"
        ? "A newer preview of this project started, so this one stopped."
        : reason === "blocked"
          ? "An earlier preview of this project with outdated environment variables could not be " +
            "stopped yet. Try again in a minute."
          : "The project's environment variables changed while the preview was starting. " +
            "Start the preview again.",
    );
  }
}

/**
 * Registers `sandbox` as a secret runtime at `generation` and admits it
 * (convex/runtimeHandles.ts). Call it before any secret reaches the sandbox;
 * on RuntimeAdmissionError the caller must not inject and should kill it.
 */
export async function admitSecretRuntime(args: {
  internalKey: string;
  projectId: Id<"projects">;
  ownerId: string;
  sandbox: Sandbox;
  generation: number;
  /** A fresh boot, which has killed the project's earlier previews. */
  replacesPreviews: boolean;
}) {
  const { internalKey, sandbox, ...rest } = args;
  const handleId = await convex.mutation(api.runtimeHandles.registerRuntime, {
    internalKey,
    ...rest,
    sandboxId: toPublicSandboxId(sandbox.provider, sandbox.id),
  });
  const admission = await convex.mutation(api.runtimeHandles.admitRuntime, { internalKey, handleId });
  if (admission !== "admitted") throw new RuntimeAdmissionError(admission);
}

/** Kills one sandbox by public id. A sandbox already gone counts as killed. */
const killSandbox = async (publicId: string) => {
  const parsed = parsePublicSandboxIdOrNull(publicId);
  // Registered from a live sandbox's own id, so a malformed one never booted.
  if (parsed) await getProvider(parsed.provider).kill(parsed.nativeId);
};

/**
 * Kills the sandboxes of revoked handles (outdated by an env change, or whose
 * kill failed before) in one sandbox, one project, or any project, and records
 * each outcome. A failed kill leaves the handle revoke_failed, which denies the
 * project's secret runtime until a later sweep kills it. Returns the revoked
 * sandboxes it found, so a caller can refuse to keep using one.
 */
export async function killRevokedRuntimes(
  internalKey: string,
  scope: { projectId?: Id<"projects">; sandboxId?: string } = {},
) {
  const sandboxId = scope.sandboxId && (canonicalSandboxIdOrNull(scope.sandboxId) ?? scope.sandboxId);
  const handles = await convex.query(api.runtimeHandles.listRevokedHandles, {
    internalKey,
    projectId: scope.projectId,
    sandboxId,
  });
  const outcomes = await Promise.all(
    handles.map(async ({ _id, sandboxId }) => {
      const killed = await killSandbox(sandboxId).then(
        () => true,
        (error: unknown) => {
          console.error("[runtime-fence] could not kill a revoked runtime", sandboxId, error);
          return false;
        },
      );
      await convex.mutation(api.runtimeHandles.recordKill, { internalKey, handleId: _id, killed });
      return killed;
    }),
  );
  return {
    sandboxIds: handles.map((handle) => handle.sandboxId),
    failed: outcomes.filter((killed) => !killed).length,
  };
}

export const REVOKED_RUNTIME_MESSAGE =
  "This preview was stopped because the project's environment variables changed. Start the preview again.";

/** Whether `publicId` is a revoked runtime, which this kills; a revoked sandbox takes no more syncs or repairs. */
export async function isRevokedRuntime(publicId: string) {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  // Without the key no boot could register a handle.
  if (!internalKey) return false;
  return (await killRevokedRuntimes(internalKey, { sandboxId: publicId })).sandboxIds.length > 0;
}
