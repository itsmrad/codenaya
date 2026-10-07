import type { Page } from "@playwright/test";

/**
 * Console errors that come from third-party code, not from the app.
 *
 * - Sentry's `/monitoring` tunnel returns 403 when events are rejected (dev,
 *   localhost origins), which the browser logs as a failed resource load.
 * - next-themes injects an inline <script> to avoid a theme flash, which
 *   React 19 warns about in development.
 */
const KNOWN_NOISE: RegExp[] = [
  /Encountered a script tag while rendering React component/,
];
const KNOWN_NOISE_URLS: RegExp[] = [/\/monitoring\?/];

/**
 * Records console errors and uncaught page errors, minus known third-party
 * noise. Call before navigating; read the returned array after the page has
 * settled.
 */
export const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const url = message.location().url;
    if (KNOWN_NOISE.some((pattern) => pattern.test(text))) return;
    if (KNOWN_NOISE_URLS.some((pattern) => pattern.test(url))) return;
    errors.push(`${text} (${url})`);
  });
  page.on("pageerror", (error) => errors.push(error.message));

  return errors;
};
