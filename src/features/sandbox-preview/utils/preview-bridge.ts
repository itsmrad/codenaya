import { z } from "zod";

import { MAX_ERROR_TEXT, type AppError } from "./app-error";

export const PREVIEW_MESSAGE_SOURCE = "codenaya-preview";
/** Bump when the message shape changes; select-to-edit (#227) extends this protocol. */
export const PREVIEW_PROTOCOL_VERSION = 1;

/**
 * The first Error among console arguments, wherever it sits: React logs a
 * caught render error after the error boundary's message (#335). Runs inside
 * the preview from its source, so it must stay self-contained.
 */
export function firstError(args: ArrayLike<unknown>): Error | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] instanceof Error) return args[i] as Error;
  }
  return null;
}

/**
 * Runs inside the previewed app and reports uncaught errors to the IDE, plus
 * errors an error boundary caught, which React reports only to console.error. The
 * preview is cross-origin, so this is the only way they leave the iframe. It is
 * injected when served (E2B proxy) or mounted (WebContainer), never written to
 * the user's files, so exports stay clean.
 */
export const PREVIEW_BRIDGE_SCRIPT = `<script data-codenaya-preview>(function(){
if (window.parent === window) return;
function post(message, stack) {
  try {
    window.parent.postMessage({
      source: ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)},
      version: ${PREVIEW_PROTOCOL_VERSION},
      kind: "runtime",
      message: String(message).slice(0, ${MAX_ERROR_TEXT}),
      stack: stack ? String(stack).slice(0, ${MAX_ERROR_TEXT}) : undefined
    }, "*");
  } catch (e) {}
}
window.addEventListener("error", function (event) {
  var error = event.error;
  post((error && error.message) || event.message || "Script error", error && error.stack);
});
window.addEventListener("unhandledrejection", function (event) {
  var reason = event.reason;
  post((reason && reason.message) || String(reason), reason && reason.stack);
});
var firstError = ${String(firstError)};
var consoleError = console.error;
console.error = function () {
  var error = firstError(arguments);
  if (error) post(error.message || String(error), error.stack);
  return consoleError.apply(this, arguments);
};
})();</script>`;

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
