import { z } from "zod";

import { MAX_ERROR_TEXT, overlayError, type AppError } from "./app-error";

export const PREVIEW_MESSAGE_SOURCE = "codenaya-preview";
/** Bump when the message shape changes; select-to-edit (#227) extends this protocol. */
export const PREVIEW_PROTOCOL_VERSION = 1;

type ErrorLike = { message?: unknown; stack?: unknown } | null | undefined;

/**
 * Runs inside the previewed app and reports its errors to the IDE: uncaught
 * errors and rejections, and errors an error boundary caught, which React
 * reports only to console.error, after "The above error occurred…" (#335), and
 * compile errors shown in Vite's error overlay (#497). The preview is
 * cross-origin, so this is the only way they leave the iframe. It runs from its
 * source, so it must stay self-contained, and it must never
 * break the app: every report is guarded and the app's console.error always runs.
 */
export function installPreviewBridge(
  win: typeof window,
  source: string,
  version: number,
  maxText: number,
): void {
  if (win.parent === win) return;
  // A new document: errors the last one reported are gone. Vite reloads the
  // page itself after re-optimizing dependencies or restarting (#486).
  win.parent.postMessage({ source, version, kind: "page", message: "" }, "*");
  let parentOrigin = "";
  try {
    // Known limitation: without ancestorOrigins (Firefox), a full-page navigation
    // inside the preview makes document.referrer the preview's own origin, so the
    // parent's commands no longer match and Select stops working. It fails closed
    // on purpose: an unverifiable embedding origin is never trusted.
    parentOrigin = win.location.ancestorOrigins?.[0] || new URL(win.document.referrer).origin;
    if (parentOrigin === "null") parentOrigin = "";
  } catch {
    // Without a known embedding origin, Select mode stays unavailable.
  }
  let selecting = false;
  let outline: HTMLDivElement | null = null;
  const stopSelecting = () => {
    selecting = false;
    outline?.remove();
    outline = null;
  };
  win.addEventListener("message", (event) => {
    try {
      if (!parentOrigin || event.origin !== parentOrigin || event.source !== win.parent ||
        event.data?.source !== source || event.data?.version !== version) return;
      if (event.data.kind === "select:on") selecting = true;
      if (event.data.kind === "select:off") stopSelecting();
    } catch {
      // Page objects must never break the app.
    }
  });
  win.addEventListener("mousemove", (event) => {
    try {
      if (!selecting || !(event.target instanceof win.Element)) return;
      if (!outline) {
        outline = win.document.createElement("div");
        outline.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid Highlight;box-sizing:border-box;color:Highlight;font:12px monospace";
        win.document.documentElement.appendChild(outline);
      }
      outline.textContent = event.target.tagName.toLowerCase() + Array.from(event.target.classList).slice(0, 2).map((name) => "." + name.slice(0, 64)).join("");
      const rect = event.target.getBoundingClientRect();
      Object.assign(outline.style, { left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
    } catch {
      // Best-effort hover decoration on an untrusted page.
    }
  }, true);
  const pick = (event: MouseEvent | KeyboardEvent, target: EventTarget | null) => {
    try {
      if (!selecting || !(target instanceof win.Element)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const rect = target.getBoundingClientRect();
      const path: string[] = [];
      let node: Element | null = target;
      while (node && path.join(" > ").length < 512) {
        const index = node.parentElement ? Array.from(node.parentElement.children).indexOf(node) + 1 : 1;
        path.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")");
        node = node.parentElement;
      }
      const element = {
        tag: target.tagName.toLowerCase().slice(0, 64),
        id: target.id.slice(0, 128),
        classes: Array.from(target.classList).slice(0, 20).map((name) => name.slice(0, 64)),
        text: (target.textContent || "").trim().slice(0, 200),
        outerHTML: target.outerHTML.slice(0, 2048),
        domPath: path.join(" > ").slice(0, 512),
        siblingText: (target.parentElement?.textContent || "").trim().slice(0, 300),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
      stopSelecting();
      win.parent.postMessage({ source, version, kind: "select:picked", element }, parentOrigin);
    } catch {
      // Reading hostile page data must never break the app.
    }
  };
  win.addEventListener("click", (event) => pick(event, event.target), true);
  win.addEventListener("keydown", (event) => {
    try {
      if (!selecting) return;
      if (event.key === "Enter" || event.key === " ") {
        // Nothing focused: leave the page's own Enter/Space handling alone.
        const active = win.document.activeElement;
        if (!active || active === win.document.body || active === win.document.documentElement) return;
        pick(event, active);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      stopSelecting();
      win.parent.postMessage({ source, version, kind: "select:off" }, parentOrigin);
    } catch {
      // Leaving Select mode is best effort.
    }
  }, true);
  let lastPosted = "";
  const post = (kind: string, message: string, detail?: string) => {
    // One error can arrive twice in the same task (window error and its log).
    // Only then: the IDE clears the banner on every edit and needs a repeat
    // after the edit to show the error again.
    const key = kind + "\n" + message + "\n" + (detail || "");
    if (key === lastPosted) return;
    lastPosted = key;
    win.setTimeout(() => {
      lastPosted = "";
    }, 0);
    win.parent.postMessage(
      kind === "build"
        ? { source, version, kind, message, file: detail }
        : { source, version, kind, message, stack: detail },
      "*",
    );
  };
  const report = (error: unknown, fallback: unknown) => {
    try {
      const found = error as ErrorLike;
      const message = String((found && found.message) || fallback).slice(0, maxText);
      const stack = found && found.stack ? String(found.stack).slice(0, maxText) : undefined;
      // A benign browser notice, not an app error; nothing to fix.
      if (/^ResizeObserver loop/.test(message)) return;
      post("runtime", message, stack);
    } catch {
      // A hostile error object must not break the app.
    }
  };

  // Vite appends a new overlay to <body> for each compile error. Its shadow
  // root is open, and it fills it in before appending.
  const reportOverlay = (node: unknown) => {
    try {
      const overlay = node as Element;
      if (!overlay || overlay.nodeName !== "VITE-ERROR-OVERLAY" || !overlay.shadowRoot) return;
      const root = overlay.shadowRoot;
      const text = (selector: string) => {
        const found = root.querySelector(selector);
        return found && found.textContent ? found.textContent.trim() : "";
      };
      const plugin = text(".plugin");
      const message = ((plugin ? plugin + " " : "") + text(".message-body")).slice(0, maxText);
      if (message) post("build", message, text(".file").slice(0, maxText) || undefined);
    } catch {
      // Same as above: reporting never gets in the app's way.
    }
  };
  const watchOverlays = () => {
    try {
      const body = win.document.body;
      if (!body) return;
      reportOverlay(body.querySelector("vite-error-overlay"));
      new win.MutationObserver((records) => {
        for (let r = 0; r < records.length; r++) {
          const added = records[r].addedNodes;
          for (let i = 0; i < added.length; i++) reportOverlay(added[i]);
        }
      }).observe(body, { childList: true });
    } catch {
      // No DOM to watch; runtime errors are still reported.
    }
  };
  if (win.document && win.document.readyState === "loading") {
    win.document.addEventListener("DOMContentLoaded", watchOverlays);
  } else {
    watchOverlays();
  }
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
        // `throw "boom"`: no Error, so React's %o argument is the thrown value.
        else if (boundaryLog && typeof args[0] === "string" && args[0].indexOf("%o") === 0) {
          report(args[1], args[1]);
        }
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

const pickedElement = z.object({
  tag: z.string().max(64),
  id: z.string().max(128).optional(),
  classes: z.array(z.string().max(64)).max(20).optional(),
  text: z.string().max(200),
  outerHTML: z.string().max(2048),
  domPath: z.string().max(512),
  siblingText: z.string().max(300).optional(),
  rect: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite(), height: z.number().finite() }),
});
export type PickedElement = z.infer<typeof pickedElement>;

const envelope = {
  source: z.literal(PREVIEW_MESSAGE_SOURCE),
  version: z.literal(PREVIEW_PROTOCOL_VERSION),

};
// A new kind, not a new shape: older bridges still send runtime messages only.
const previewMessage = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("runtime"), message: z.string(), stack: z.string().optional() }),
  z.object({ ...envelope, kind: z.literal("build"), message: z.string(), file: z.string().optional() }),
  z.object({ ...envelope, kind: z.literal("page"), message: z.string() }),
  z.object({ ...envelope, kind: z.literal("select:picked"), element: pickedElement }),
  z.object({ ...envelope, kind: z.literal("select:off") }),
]);

/**
 * The origin to post to or accept messages from, or null for a preview URL that
 * has none worth trusting (about:blank, blob:, garbage): only http(s) qualifies.
 */
export const previewTargetOrigin = (previewUrl: string | null | undefined): string | null => {
  if (!previewUrl) return null;
  try {
    const url = new URL(previewUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

/**
 * The error a preview message reports, a new page, or null. Only the preview
 * iframe's own window on the preview's origin is trusted; anything else on
 * the page can post messages too.
 */
export const readPreviewMessage = (
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  frame: Window | null | undefined,
  previewUrl: string | null | undefined,
): AppError | { kind: "page" } | { kind: "select:off" } | { kind: "select:picked"; element: PickedElement } | null => {
  const origin = previewTargetOrigin(previewUrl);
  if (!frame || !origin || event.source !== frame || event.origin !== origin) return null;
  const parsed = previewMessage.safeParse(event.data);
  if (!parsed.success) return null;
  if (parsed.data.kind === "select:picked") return { kind: "select:picked", element: parsed.data.element };
  if (parsed.data.kind === "select:off") return { kind: "select:off" };
  if (parsed.data.kind === "page") return { kind: "page" };
  if (parsed.data.kind === "build") return overlayError(parsed.data.message, parsed.data.file);
  return {
    kind: "runtime",
    message: parsed.data.message.slice(0, MAX_ERROR_TEXT) || "Uncaught error",
    stack: parsed.data.stack?.slice(0, MAX_ERROR_TEXT),
  };
};

/** Select messages never enter the error setter, including when a banner is already shown. */
export const routePreviewMessage = (
  reported: ReturnType<typeof readPreviewMessage>,
  onError: (error: AppError | null) => void,
  onPick: (element: PickedElement) => void,
  onSelectOff: () => void,
) => {
  if (!reported) return;
  if (reported.kind === "select:picked") onPick(reported.element);
  else if (reported.kind === "select:off") onSelectOff();
  else if (reported.kind === "page") onError(null);
  else onError(reported);
};
