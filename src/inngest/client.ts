import { Inngest } from "inngest";
import { sentryMiddleware } from "@inngest/middleware-sentry";

// Create a client to send and receive events
export const inngest = new Inngest({ 
  id: "codenaya",
  middleware: [sentryMiddleware()],
});

// Inngest rejects an app sync when any function's concurrency limit exceeds the plan's (5 today).
export const INNGEST_PLAN_CONCURRENCY_LIMIT = 5;
