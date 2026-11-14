import { inngest } from "@/inngest/client";

import { killRepairSandboxes } from "./build-repair";

/**
 * Stops the build-repair sandboxes of a run that failed or was cancelled
 * (including by a newer message), which skips the run's own kill step.
 * Not filtered to process-message: only its runs start them, and the lookup
 * is by run id, so any other run finds none.
 */
export const stopRepairSandboxes = inngest.createFunction(
  {
    id: "stop-repair-sandboxes",
    triggers: [{ event: "inngest/function.failed" }, { event: "inngest/function.cancelled" }],
  },
  async ({ event, step }) => {
    await step.run("kill-repair-sandboxes", () => killRepairSandboxes(event.data.run_id));
  },
);
