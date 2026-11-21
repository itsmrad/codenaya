import { NonRetriableError } from "inngest";

import { inngest } from "@/inngest/client";

import { killRevokedRuntimes } from "../server/runtime-fence";

/**
 * Backstop for env changes that no route kills after: client public saves,
 * project and account deletes, and kills that failed. Every 5 minutes, one at a
 * time; each run takes a bounded batch and the next run takes the rest. Not every
 * minute: it runs whether or not anything is revoked, and every run counts
 * against the plan's monthly Inngest allowance that agent runs share.
 */
export const sweepRevokedRuntimes = inngest.createFunction(
  {
    id: "sweep-revoked-runtimes",
    triggers: [{ cron: "*/5 * * * *" }],
    concurrency: { limit: 1 },
  },
  async ({ step }) =>
    step.run("kill-revoked-runtimes", () => {
      const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
      if (!internalKey) throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not set");
      return killRevokedRuntimes(internalKey);
    }),
);
