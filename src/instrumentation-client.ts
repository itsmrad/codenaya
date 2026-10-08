// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

import { parseTracesSampleRate } from "@/lib/sentry";

// Inlined at build time. Sentry stays off when it is unset.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  // Off in `next dev`: the `/monitoring` tunnel rejects localhost events with a
  // 403, which logs console errors on every page.
  enabled: process.env.NODE_ENV === "production" && !!dsn,

  dsn,

  // Add optional integrations for additional features
  integrations: [Sentry.replayIntegration()],

  // Share of traces sent, from NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE (0-1, default 0.1).
  tracesSampleRate: parseTracesSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  ),
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  // No user PII (IP addresses, cookies) by default; Replay masks all text and
  // media on its own defaults. Opt in per field rather than flipping this on.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
