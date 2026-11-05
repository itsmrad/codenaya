import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { processMessage } from "@/features/conversations/inngest/process-message";
import { importGithubRepo } from "@/features/projects/inngest/import-github-repo";
import { exportToGithub } from "@/features/projects/inngest/export-to-github";
import { pushToGithub } from "@/features/projects/inngest/push-to-github";
import { pullFromGithub } from "@/features/projects/inngest/pull-from-github";

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processMessage,
    importGithubRepo,
    exportToGithub,
    pushToGithub,
    pullFromGithub,
  ],
});