import { inngest } from "@/inngest/client";

import { killRepairSandboxes } from "./build-repair";
import { processMessage } from "./process-message";

/** How Inngest names the message run in its system events: "codenaya-process-message". */
const RUN_FILTER = `event.data.function_id == '${processMessage.id(inngest.id)}'`;

/**
 * Stops the build-repair sandboxes of a message run that failed or was
 * cancelled (including by a newer message), which skips the run's own kill
 * step. Never fails: a failure here would emit function.failed again.
 */
export const stopRepairSandboxes = inngest.createFunction(
  {
    id: "stop-repair-sandboxes",
    triggers: [
      { event: "inngest/function.failed", if: RUN_FILTER },
      { event: "inngest/function.cancelled", if: RUN_FILTER },
    ],
  },
  async ({ event, step }) => {
    await step.run("kill-repair-sandboxes", () =>
      killRepairSandboxes(event.data.run_id).catch((error) => {
        console.error("[build-repair] could not stop a finished run's repair sandboxes", error);
      }),
    );
  },
);
