import type { Page } from "@playwright/test";

/**
 * Records console errors and uncaught page errors. Call before navigating;
 * read the returned array after the page has settled.
 */
export const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    errors.push(`${message.text()} (${message.location().url})`);
  });
  page.on("pageerror", (error) => errors.push(error.message));

  return errors;
};
