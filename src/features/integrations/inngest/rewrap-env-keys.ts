import { NonRetriableError } from "inngest";

import { inngest } from "@/inngest/client";

import {
  emptyReport,
  mergeReport,
  runEnvKeyPage,
  type EnvKeyPassMode,
} from "../server/env/rewrap-env-keys";

/**
 * Moves every env-var DEK wrap to the current KMS key, then verifies every row
 * (see `rewrap-env-keys.ts` and docs/env-kms-key-migration.md). Internal only:
 * there is no route; an operator sends `env-vars/kms.rewrap` from the Inngest
 * dashboard. One run at a time. Each page is a step, so a retry resumes where
 * it stopped, and a fresh run skips rows already moved. Steps return counts,
 * row ids and key ids only.
 *
 * shortcut: one run covers at most ~25k env-var rows, public ones included
 * (Inngest's 1000-step cap over two passes of 50-row pages); carry the cursor
 * into a follow-up event when the table grows past that.
 */
export const rewrapEnvKeys = inngest.createFunction(
  {
    id: "rewrap-env-keys",
    triggers: [{ event: "env-vars/kms.rewrap" }],
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
    if (!internalKey) throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not set");
    // Until the activation stage, previews still open secrets through the legacy
    // sealer, which cannot read a row moved to AWS KMS.
    if (process.env.ENV_VARS_SECRET_RUNTIME !== "on") {
      throw new NonRetriableError("ENV_VARS_SECRET_RUNTIME is not on; refusing to move env-var keys.");
    }

    const reports = { rewrap: emptyReport(), verify: emptyReport() };
    for (const mode of ["rewrap", "verify"] as EnvKeyPassMode[]) {
      let cursor: string | null = null;
      for (let i = 0; ; i++) {
        const page = await step.run(`${mode}-page-${i}`, () => runEnvKeyPage(mode, internalKey, cursor));
        mergeReport(reports[mode], page);
        if (page.done) break;
        cursor = page.cursor;
      }
    }
    return reports;
  },
);
