import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable Next.js 16 Partial Prerendering and Cache Components
  cacheComponents: true,
  allowedDevOrigins: ['10.5.0.2', '192.168.1.34'],
  poweredByHeader: false,
  // Stop `next dev` upserting its agent-rules block into AGENTS.md (#81).
  agentRules: false,
  async headers() {
    return [
      {
        // Nothing frames this app; it only frames others (the preview iframe).
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // The composer records dictation (#301); nothing else gets the mic.
            value: "camera=(), microphone=(self), geolocation=()",
          },
        ],
      },
      {
        // Apply only when explicitly requesting webcontainer via query param
        source: "/projects/:path*",
        has: [
          {
            type: "query",
            key: "engine",
            value: "webcontainer",
          }
        ],
        headers: [
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "require-corp",
          },
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  // `org` comes from SENTRY_ORG, or from the org-scoped SENTRY_AUTH_TOKEN.
  project: process.env.SENTRY_PROJECT ?? "codenaya",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  }
});
