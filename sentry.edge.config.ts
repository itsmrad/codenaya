// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

import { parseTracesSampleRate } from "./src/lib/sentry";

// Server-only SENTRY_DSN wins; NEXT_PUBLIC_SENTRY_DSN (shared with the client)
// is the fallback. Sentry stays off when neither is set.
const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  // Report from production builds only, like the client config: events from
  // `next dev` are noise.
  enabled: process.env.NODE_ENV === "production" && !!dsn,

  dsn,

  // Share of traces sent, from NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE (0-1, default 0.1).
  tracesSampleRate: parseTracesSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  ),

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // No user PII (IP addresses, cookies, request bodies) by default. This also
  // keeps vercelAIIntegration from recording LLM prompts and outputs, which
  // carry users' code. Opt in per field rather than flipping this on.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: false,
  integrations: [
    Sentry.vercelAIIntegration,
    // send console.log, console.warn, and console.error calls as logs to Sentry
    Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
  ],
});
