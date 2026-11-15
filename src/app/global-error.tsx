"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Replaces the root layout, so no providers, fonts or globals.css are loaded:
// plain elements with the app's light/dark tokens copied into a <style> tag.
// Mirrors `ErrorRetryView` (headline, one line, Try again + Back to home).
const STYLES = `
  :root { --bg: #faf8f5; --fg: #1a1a1a; --muted: #6b6560; --border: rgba(26,26,26,.16); --primary: #1a1a1a; --primary-fg: #faf8f5; --ring: #e8824f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #09090b; --fg: #f0ece6; --muted: #8a8580; --border: rgba(255,255,255,.16); --primary: #f0ece6; --primary-fg: #09090b; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, sans-serif; }
  main { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: 0 1rem; text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; font-weight: 600; }
  p { margin: 0; max-width: 28rem; font-size: .875rem; color: var(--muted); }
  .actions { display: flex; gap: .5rem; }
  .btn { display: inline-flex; align-items: center; height: 2rem; padding: 0 .75rem; border-radius: .5rem; border: 1px solid var(--border); background: transparent; color: var(--fg); font: inherit; font-size: .875rem; font-weight: 500; text-decoration: none; cursor: pointer; }
  .btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
  .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
`;

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Something went wrong — Codenaya</title>
        <style>{STYLES}</style>
      </head>
      <body>
        <main>
          <div>
            <h1>Something went wrong</h1>
            <p>Codenaya hit an unexpected error. Try again, or head back home.</p>
          </div>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => retry()}>
              Try again
            </button>
            {/* A plain anchor: there is no router outside the root layout. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="btn" href="/">
              Back to home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
