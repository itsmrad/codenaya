import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { BootHistory } from "../utils/boot-phase";

/**
 * `sandbox_running` with install and dev-server boot times. Best effort: the
 * preview is already up, so a failed write only loses the event.
 */
export async function recordSandboxRunning(
  internalKey: string,
  projectId: Id<"projects">,
  { install, start, ready }: BootHistory,
) {
  if (!install || !start || !ready) return;
  try {
    await convex.mutation(api.activationEvents.recordSandboxRunning, {
      internalKey,
      projectId,
      installMs: start.at - install.at,
      bootMs: ready.at - start.at,
    });
  } catch (error) {
    console.error("[sandbox] failed to record sandbox_running", error);
  }
}
