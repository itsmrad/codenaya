import { z } from "zod";

import { MAX_ERROR_TEXT, type AppError } from "./app-error";

export const PREVIEW_MESSAGE_SOURCE = "codenaya-preview";
/** Bump when the message shape changes; select-to-edit (#227) extends this protocol. */
export const PREVIEW_PROTOCOL_VERSION = 1;

type ErrorLike = { message?: unknown; stack?: unknown } | null | undefined;

/**
 * Runs inside the previewed app and reports its errors to the IDE: uncaught
 * errors and rejections, and errors an error boundary caught, which React
 * reports only to console.error, after "The above error occurred…" (#335). The
 * preview is cross-origin, so this is the only way they leave the iframe. It
 * runs from its source, so it must stay self-contained, and it must never
 * break the app: every report is guarded and the app's console.error always runs.
 */
export function installPreviewBridge(
  win: typeof window,
  source: string,
  version: number,
  maxText: number,
): void {
  if (win.parent === win) return;
  let lastPosted = "";
  const report = (error: unknown, fallback: unknown) => {
    try {
      const found = error as ErrorLike;
      const message = String((found && found.message) || fallback).slice(0, maxText);
      const stack = found && found.stack ? String(found.stack).slice(0, maxText) : undefined;
      // One error often arrives twice (window error and a log, or a repeated log).
      const key = message + "\n" + (stack || "");
      if (key === lastPosted) return;
      lastPosted = key;
      win.parent.postMessage({ source, version, kind: "runtime", message, stack }, "*");
    } catch {
      // A hostile error object must not break the app.
    }
  };
  win.addEventListener("error", (event) => report(event.error, event.message || "Script error"));
  win.addEventListener("unhandledrejection", (event) => report(event.reason, event.reason));

  const consoleError = win.console.error;
  let reporting = false;
  win.console.error = function (this: unknown, ...args: unknown[]) {
    if (!reporting) {
      reporting = true;
      try {
        // Only React's log for a boundary-caught error: an app's own
        // `catch (e) { console.error(e) }` is handled and stays quiet.
        let boundaryLog = false;
        let error: unknown = null;
        for (const arg of args) {
          if (typeof arg === "string" && arg.indexOf("The above error occurred") === 0) {
            boundaryLog = true;
          } else if (error === null && arg instanceof Error) {
            error = arg;
          }
        }
        if (boundaryLog && error) report(error, "Uncaught error");
      } catch {
        // Same as above: reporting never gets in the app's way.
      } finally {
        reporting = false;
      }
    }
    return consoleError.apply(this, args);
  };
}

/**
 * The bridge as a script tag. It is injected when served (E2B proxy) or
 * mounted (WebContainer), never written to the user's files, so exports stay clean.
 */
export const PREVIEW_BRIDGE_SCRIPT = `<script data-codenaya-preview>(${String(installPreviewBridge)})(window, ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)}, ${PREVIEW_PROTOCOL_VERSION}, ${MAX_ERROR_TEXT});</script>`;

/**
 * Puts `bridge` first in <head>, so it is listening before the app's scripts
 * run. The E2B proxy runs this function's source inside the sandbox, so it
 * must stay self-contained: no references outside its body.
 */
export function insertBridge(html: string, bridge: string): string {
  if (html.includes("data-codenaya-preview")) return html;
  const anchor = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
  if (!anchor || anchor.index === undefined) return bridge + html;
  const end = anchor.index + anchor[0].length;
  return html.slice(0, end) + bridge + html.slice(end);
}

export const injectPreviewBridge = (html: string) => insertBridge(html, PREVIEW_BRIDGE_SCRIPT);

const runtimeMessage = z.object({
  source: z.literal(PREVIEW_MESSAGE_SOURCE),
  version: z.literal(PREVIEW_PROTOCOL_VERSION),
  kind: z.literal("runtime"),
  message: z.string(),
  stack: z.string().optional(),
});

/**
 * The runtime error a preview message reports, or null. Only the preview
 * iframe's own window on the preview's origin is trusted; anything else on
 * the page can post messages too.
 */
export const readPreviewMessage = (
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  frame: Window | null | undefined,
  previewUrl: string | null | undefined,
): AppError | null => {
  if (!frame || !previewUrl || event.source !== frame) return null;
  try {
    if (event.origin !== new URL(previewUrl).origin) return null;
  } catch {
    return null;
  }
  const parsed = runtimeMessage.safeParse(event.data);
  if (!parsed.success) return null;
  return {
    kind: "runtime",
    message: parsed.data.message.slice(0, MAX_ERROR_TEXT) || "Uncaught error",
    stack: parsed.data.stack?.slice(0, MAX_ERROR_TEXT),
  };
};
