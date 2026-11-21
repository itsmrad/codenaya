import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toPublicSandboxId } from "./provider/ids";
import type { Sandbox } from "./provider/types";

/** The project's env changed (or it was deleted), or a newer boot replaced this one, after it read the env. */
export class RuntimeAdmissionError extends Error {
  name = "RuntimeAdmissionError";
  constructor(reason: "replaced" | "outdated") {
    super(
      reason === "replaced"
        ? "A newer preview of this project started, so this one stopped."
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
