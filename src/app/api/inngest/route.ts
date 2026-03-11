import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { demoError, demoGenerate } from "@/inngest/functions";
import { processMessage } from "@/features/conversations/inngest/process-message";

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    demoGenerate,
    demoError,
    processMessage,
  ],
});