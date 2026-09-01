"use client";

import React from "react";
import ky, { HTTPError, TimeoutError } from "ky";

/**
 * Drives the popup half of the MCP OAuth flow.
 *
 * ## Why a popup
 *
 * `/api/integrations/oauth/start` hands back an `authorizationUrl` instead of a
 * 302 precisely so the editor stays mounted: a full-page redirect out of a
 * project would discard unsaved editor state. The popup carries the flow and the
 * callback page (`/api/integrations/oauth/callback`) reports the outcome back
 * with `postMessage` before closing itself.
 *
 * ## What this hook guarantees
 *
 * 1. Messages are only trusted when `event.origin` is this exact origin and the
 *    payload carries our own `source` marker. Without the origin check any page
 *    holding a reference to this window could post a forged success.
 * 2. A popup the browser refuses to open — or one that is closed the instant it
 *    opens — is reported as its own actionable error rather than a spinner that
 *    never resolves.
 * 3. A popup the *user* closes without finishing resolves as `cancelled`, found
 *    by polling `popup.closed` (there is no event for it).
 * 4. The flow settles exactly once. The callback closes its window ~600ms after
 *    posting success, so the close poll always fires *after* a successful
 *    message; a latch keeps that from becoming a second state transition.
 * 5. The message listener and the poll are torn down on settle and on unmount,
 *    and no state is written after unmount.
 *
 * The window is deliberately *not* closed on unmount: the callback route has
 * already persisted the connection by then, and the connections list is a live
 * Convex query, so killing the window would only abort a flow that was about to
 * succeed.
 */

/** Marker the callback page stamps on its `postMessage` payload. */
const MESSAGE_SOURCE = "codenaya-oauth";

/** `popup.closed` has no event, so it has to be polled. */
const CLOSED_POLL_INTERVAL_MS = 400;

const POPUP_WIDTH = 620;
const POPUP_HEIGHT = 780;

const FALLBACK_ERROR =
  "Unable to start the sign-in flow. Please try again.";

const POPUP_BLOCKED_ERROR =
  "Your browser blocked the sign-in window. Allow popups for this site, then try again.";

const TIMEOUT_ERROR =
  "The provider took too long to prepare the sign-in. Please try again.";

/**
 * `/oauth/start` performs authorization-server discovery and dynamic client
 * registration against the provider before it can answer, which is slower than
 * ky's 10s default allows for.
 */
const START_TIMEOUT_MS = 25_000;

/** Shown while `/oauth/start` is still resolving the authorization URL. */
const PLACEHOLDER_DOCUMENT = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Connecting...</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #0b0b0c; color: #a1a1aa; }
  p { font-size: .8125rem; }
</style>
</head>
<body><p>Connecting...</p></body>
</html>`;

export type OAuthPopupState =
  | "idle"
  | "pending"
  | "success"
  | "error"
  | "cancelled";

/** Terminal states, i.e. everything `settle` may move to. */
type SettledState = Exclude<OAuthPopupState, "idle" | "pending">;

interface OAuthStartResponse {
  ok: true;
  authorizationUrl: string;
  provider: { id: string; displayName: string };
  expiresAt: number;
}

interface OAuthCallbackMessage {
  source: typeof MESSAGE_SOURCE;
  status: "success" | "error";
  message?: string;
}

/**
 * Whether a `MessageEvent` payload is one of ours.
 *
 * Extensions, embeds and dev tooling all post into the page, so an unrecognised
 * payload is ignored rather than treated as a failure.
 */
const isCallbackMessage = (data: unknown): data is OAuthCallbackMessage => {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    candidate.source === MESSAGE_SOURCE &&
    (candidate.status === "success" || candidate.status === "error")
  );
};

/**
 * Whether a `message` event should be treated as an OAuth callback result.
 *
 * Extracted as a pure function specifically so it can be tested without a DOM
 * environment. This is the security boundary of the popup flow: without the
 * origin comparison, any page able to reach `window.opener` could post a forged
 * `{ status: "success" }` and make the UI report a connection that never
 * happened.
 */
export const shouldAcceptCallbackMessage = (args: {
  eventOrigin: string;
  expectedOrigin: string;
  data: unknown;
}): boolean => {
  if (args.eventOrigin !== args.expectedOrigin) return false;
  return isCallbackMessage(args.data);
};

/**
 * User-facing text for a failed `/oauth/start`.
 *
 * The route already returns actionable messages (misconfiguration, unknown
 * provider, provider-side discovery failure), so they are surfaced verbatim.
 */
const readStartError = async (error: unknown): Promise<string> => {
  if (error instanceof HTTPError) {
    const body = await error.response
      .json<{ error?: string }>()
      .catch(() => ({ error: undefined }));
    return body.error ?? FALLBACK_ERROR;
  }
  if (error instanceof TimeoutError) {
    return TIMEOUT_ERROR;
  }
  return FALLBACK_ERROR;
};

const popupFeatures = (): string => {
  const left =
    window.screenX + Math.max(0, (window.outerWidth - POPUP_WIDTH) / 2);
  const top =
    window.screenY + Math.max(0, (window.outerHeight - POPUP_HEIGHT) / 3);

  return [
    "popup=yes",
    `width=${POPUP_WIDTH}`,
    `height=${POPUP_HEIGHT}`,
    `left=${Math.round(left)}`,
    `top=${Math.round(top)}`,
  ].join(",");
};

export interface UseOAuthPopupResult {
  state: OAuthPopupState;
  /** Set only in the `error` state. */
  error: string | null;
  start: (providerId: string) => Promise<void>;
  reset: () => void;
}

export const useOAuthPopup = (): UseOAuthPopupResult => {
  const [state, setState] = React.useState<OAuthPopupState>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const popupRef = React.useRef<Window | null>(null);
  const pollRef = React.useRef<number | null>(null);
  const listenerRef = React.useRef<((event: MessageEvent) => void) | null>(
    null,
  );
  /** Latch: the first outcome wins, later ones are dropped. */
  const settledRef = React.useRef(false);
  /** Guards against a second `start` while one is already in flight. */
  const inFlightRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  const teardown = React.useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (listenerRef.current !== null) {
      window.removeEventListener("message", listenerRef.current);
      listenerRef.current = null;
    }
    popupRef.current = null;
    inFlightRef.current = false;
  }, []);

  // Unmount is the only place a listener could outlive its consumer, so the
  // cleanup both detaches everything and closes the door on further setState.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  const settle = React.useCallback(
    (next: SettledState, message: string | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      teardown();
      if (!mountedRef.current) return;
      setState(next);
      setError(message);
    },
    [teardown],
  );

  const reset = React.useCallback(() => {
    settledRef.current = false;
    teardown();
    setState("idle");
    setError(null);
  }, [teardown]);

  const start = React.useCallback(
    async (providerId: string) => {
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      settledRef.current = false;
      setState("pending");
      setError(null);

      // Opened before any `await` so the click's user activation still applies —
      // a window opened after the round-trip is blocked by most browsers. It
      // starts blank and is navigated once the authorization URL comes back.
      const popup = window.open("", MESSAGE_SOURCE, popupFeatures());

      if (!popup || popup.closed) {
        settle("error", POPUP_BLOCKED_ERROR);
        return;
      }

      popupRef.current = popup;

      try {
        // Same-origin (`about:blank` inherits the opener), so this is only a
        // placeholder for the second or two discovery and registration take.
        popup.document.write(PLACEHOLDER_DOCUMENT);
        popup.document.close();
      } catch {
        // Cosmetic only — a browser that refuses this still runs the flow.
      }

      let authorizationUrl: string;
      try {
        const result = await ky
          .post("/api/integrations/oauth/start", {
            json: { providerId },
            timeout: START_TIMEOUT_MS,
          })
          .json<OAuthStartResponse>();
        authorizationUrl = result.authorizationUrl;
      } catch (requestError) {
        popup.close();
        settle("error", await readStartError(requestError));
        return;
      }

      // The user can close the placeholder while `/oauth/start` is in flight.
      if (popup.closed) {
        settle("cancelled", null);
        return;
      }

      // Listening before navigating removes any window in which the callback
      // could post before we are subscribed.
      const onMessage = (event: MessageEvent) => {
        // Both checks are load-bearing: the origin check is what stops a forged
        // success from another page, the marker check keeps unrelated
        // postMessage traffic from being mistaken for a result.
        if (!shouldAcceptCallbackMessage({
          eventOrigin: event.origin,
          expectedOrigin: window.location.origin,
          data: event.data,
        })) {
          return;
        }

        if (!isCallbackMessage(event.data)) return;

        if (event.data.status === "success") {
          settle("success", null);
          return;
        }

        settle("error", event.data.message?.trim() || FALLBACK_ERROR);
      };

      listenerRef.current = onMessage;
      window.addEventListener("message", onMessage);

      pollRef.current = window.setInterval(() => {
        // `closed` stays readable after the popup navigates cross-origin. The
        // latch in `settle` is what keeps this from firing a second transition
        // after the callback's own success message.
        if (popup.closed) {
          settle("cancelled", null);
        }
      }, CLOSED_POLL_INTERVAL_MS);

      popup.location.href = authorizationUrl;
    },
    [settle],
  );

  return { state, error, start, reset };
};
